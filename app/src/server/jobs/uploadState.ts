import { Prisma, type Platform } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { openSecret, sealSecret } from "@/lib/tokenCrypto";
import type { PendingResultFailure } from "@/server/jobs/failPendingResults";

/**
 * 2026-11-02 scale audit (jobs, chunked uploads): where a large video upload
 * stands between two Inngest steps.
 *
 * A platform step has a 225 s budget (publishBudget.ts), so a large upload spans
 * several steps. The client saves its progress here before it reports a
 * continuation, and the next step loads it and carries on. The state lives on
 * `PostJobResult.uploadState` (one JSON document per result):
 *
 *   { v, runId, platform, kind, savedAt, data, secret? }
 *
 * - `data` is progress and ids only (offsets, a media id, a part number). `save`
 *   refuses a `data` that holds a URL (`://`), so a capability URL cannot land here.
 * - `secret` is `sealSecret(JSON.stringify(...))` (tokenCrypto.ts), the way
 *   SocialConnection tokens are sealed. Capability URLs - the YouTube session
 *   URI, TikTok's `upload_url`, LinkedIn's part URLs and multipart `metadata` -
 *   go there and nowhere else: anyone holding one can write to (or finish) the
 *   upload, so none may be readable in the table, a dump, a step output or a log.
 * - `runId`, `platform` and `kind` scope it: state saved by another run (a retry
 *   starts a new one) or by another kind of upload is ignored, never resumed.
 * - Writes are claim-scoped. A run that no longer holds the claim cannot write.
 *
 * The state is cleared by `finalizeClaimedResult` (both outcomes) and by the
 * retry route's re-queue, and kept by a rate-limit deferral and a continuation
 * (resultClaim.ts). Nothing here ever reaches the platform.
 */

export const UPLOAD_STATE_VERSION = 1;

/**
 * The largest state document (sealed secret included) a result may hold. Every
 * step re-reads it from the database, so it stays small; 512 KiB holds a
 * 128-part LinkedIn upload (a URL, a byte range and headers per part) with room.
 */
export const MAX_UPLOAD_STATE_BYTES = 524_288;

/** `save` found the claim gone: another run took over or the result was failed. Nothing was posted. */
export const RESULT_CLAIM_LOST_CODE = "RESULT_CLAIM_LOST";

/** `save` refused a state over {@link MAX_UPLOAD_STATE_BYTES}. Nothing was posted. */
export const UPLOAD_STATE_TOO_LARGE_CODE = "UPLOAD_STATE_TOO_LARGE";

/**
 * `save` refused a state whose readable `data` holds a URL (anything with `://`).
 * Capability URLs go only in the sealed `secret`; one in `data` would sit in the
 * table in plaintext. Nothing was posted.
 */
export const UPLOAD_STATE_PLAINTEXT_URL_CODE = "UPLOAD_STATE_PLAINTEXT_URL";

/**
 * The `kind` of a YouTube resumable-upload session (youtubeClient.ts saves and
 * loads under it). `publishToPlatform` looks for state of this kind to tell a
 * session that is already running from one that still has to start, because only
 * starting one spends a slot of the daily upload counter (youtubeQuota.ts).
 */
export const YOUTUBE_UPLOAD_STATE_KIND = "youtube_resumable";

/**
 * What a result is failed with when it still has more to upload after
 * MAX_CONTINUATIONS_PER_RESULT steps (platformSteps.ts). Nothing was posted: the
 * commit call is the last thing an upload does.
 */
export const UPLOAD_INCOMPLETE = {
  errorCode: "UPLOAD_INCOMPLETE",
  errorMessage: "The upload didn't finish in time. Nothing was posted — please retry.",
} as const satisfies PendingResultFailure;

/** What a client saves: plain progress in `data`, capability URLs (and anything else sensitive) in `secret`. */
export interface UploadSnapshot<D, S = never> {
  data: D;
  secret?: S;
}

/**
 * One result's upload state, bound to the run and platform that own it. `kind`
 * names the upload protocol (for example `youtube_resumable`); `load` returns
 * null for state of another kind, run or platform, and for a state that cannot
 * be read back (the client then starts the upload over).
 */
export interface UploadStateStore {
  load<D, S = never>(kind: string): Promise<UploadSnapshot<D, S> | null>;
  /**
   * Claim-scoped. Throws RESULT_CLAIM_LOST, UPLOAD_STATE_TOO_LARGE or
   * UPLOAD_STATE_PLAINTEXT_URL (a URL in `data`): all are failures before anything
   * was posted.
   */
  save<D, S = never>(kind: string, snapshot: UploadSnapshot<D, S>): Promise<void>;
  clear(): Promise<void>;
}

interface StoredUploadState {
  v: number;
  runId: string;
  platform: string;
  kind: string;
  savedAt: string;
  data: unknown;
  /** `sealSecret(JSON.stringify(secret))`. */
  secret?: string;
}

function isStoredUploadState(value: unknown): value is StoredUploadState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  return (
    typeof doc.v === "number" &&
    typeof doc.runId === "string" &&
    typeof doc.platform === "string" &&
    typeof doc.kind === "string" &&
    "data" in doc &&
    (doc.secret === undefined || typeof doc.secret === "string")
  );
}

function uploadStateError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function createUploadStateStore(args: {
  resultId: string;
  runId: string;
  platform: Platform;
}): UploadStateStore {
  const { resultId, runId, platform } = args;
  /** The claim scope shared by every write: this run's claim on a still-pending result. */
  const claimed = { id: resultId, claimRunId: runId, status: "pending" } as const;

  return {
    async load<D, S = never>(kind: string): Promise<UploadSnapshot<D, S> | null> {
      const row = await prisma.postJobResult.findUnique({
        where: { id: resultId },
        select: { uploadState: true },
      });
      const stored: unknown = row?.uploadState;
      if (!isStoredUploadState(stored)) return null;
      if (
        stored.v !== UPLOAD_STATE_VERSION ||
        stored.runId !== runId ||
        stored.platform !== platform ||
        stored.kind !== kind
      ) {
        return null;
      }
      if (stored.secret === undefined) return { data: stored.data as D };

      // The reasons are logged as fixed words, never the error: a JSON parse
      // error quotes a snippet of the text it choked on.
      let plain: string;
      try {
        plain = openSecret(stored.secret);
      } catch {
        logger.warn("[UploadState] Saved upload state could not be opened; the upload starts over", {
          resultId,
          runId,
          platform,
          kind,
          reason: "open-failed",
        });
        return null;
      }
      try {
        return { data: stored.data as D, secret: JSON.parse(plain) as S };
      } catch {
        logger.warn("[UploadState] Saved upload state could not be read; the upload starts over", {
          resultId,
          runId,
          platform,
          kind,
          reason: "not-json",
        });
        return null;
      }
    },

    async save<D, S = never>(kind: string, snapshot: UploadSnapshot<D, S>): Promise<void> {
      // 2026-11-02 scale audit (jobs B3): `data` is stored readable, so a capability
      // URL in it (the YouTube session URI, TikTok's upload_url, LinkedIn's part
      // URLs) would be a plaintext write capability in the table. `://` is in every
      // such URL. The check is on the serialized form, so a URL nested anywhere in
      // `data` is caught. The error says nothing about the value.
      if ((JSON.stringify(snapshot.data) ?? "").includes("://")) {
        throw uploadStateError(
          UPLOAD_STATE_PLAINTEXT_URL_CODE,
          "The upload could not be tracked. Nothing was posted — please retry.",
        );
      }
      const stored: StoredUploadState = {
        v: UPLOAD_STATE_VERSION,
        runId,
        platform,
        kind,
        savedAt: new Date().toISOString(),
        data: snapshot.data,
      };
      if (snapshot.secret !== undefined) {
        stored.secret = sealSecret(JSON.stringify(snapshot.secret));
      }
      if (Buffer.byteLength(JSON.stringify(stored), "utf8") > MAX_UPLOAD_STATE_BYTES) {
        throw uploadStateError(
          UPLOAD_STATE_TOO_LARGE_CODE,
          "The upload could not be tracked. Nothing was posted — please retry.",
        );
      }

      const { count } = await prisma.postJobResult.updateMany({
        where: claimed,
        data: { uploadState: stored as unknown as Prisma.InputJsonObject },
      });
      if (count === 0) {
        throw uploadStateError(
          RESULT_CLAIM_LOST_CODE,
          "This post changed while its video was uploading. Nothing was posted — please retry.",
        );
      }
    },

    async clear(): Promise<void> {
      // A count of 0 is fine: the state is already gone, or the claim is (and the
      // next write of this run finds that out).
      await prisma.postJobResult.updateMany({
        where: claimed,
        data: { uploadState: Prisma.DbNull },
      });
    },
  };
}
