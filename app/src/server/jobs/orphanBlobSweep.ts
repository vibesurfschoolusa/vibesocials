import { del as blobDel, list as blobList } from "@vercel/blob";

import { guardBlobKey } from "@/lib/blobUrl";
import { prisma } from "@/lib/db";
import { inngest } from "@/lib/inngest";
import { logger } from "@/lib/logger";
import { BLOB_DELETE_TIMEOUT_MS } from "@/server/jobs/mediaBlob";

/**
 * Uploads nobody registered (F5, review R1 M3). A browser gets an upload token,
 * writes the file, then registers it as a MediaItem; when the last step never
 * happens (the tab closed, the link's day was full) the file stays in storage,
 * uncounted and never deleted. Once a day this lists the two upload places and
 * deletes files older than ORPHAN_MIN_AGE_MS that no MediaItem, video cover or
 * report logo refers to.
 *
 * The places: client upload links write `ul/<link id>/<16 hex>-<name>`
 * (lib/uploadLink.ts); signed-in uploads write `<ms>-<random>-<name>` at the
 * root (lib/blobKey.ts). Covers (`covers/`) and logos (`logos/`) are folders,
 * so the folded root listing never shows them, and the shape checks below
 * leave any other file alone.
 *
 * Never deletes a referenced file: a page's files are first matched exactly in
 * one query per table, and a file that matched nothing is checked again by its
 * path (so another spelling of the address, or a soft-deleted row, also keeps
 * it) under the advisory lock the registration routes and deleteBlobUnlessShared
 * take, right before its delete.
 */

/** A file younger than this may still be on its way to being registered. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** How long one run may spend, well inside an Inngest step's limit. */
export const ORPHAN_SWEEP_BUDGET_MS = 120_000;

const LINK_FILE = /^ul\/[A-Za-z0-9_-]+\/[0-9a-f]{16}-[A-Za-z0-9._-]+$/;
const SIGNED_IN_FILE = /^\d{13}-[a-z0-9]*-[^/]+$/;

const SOURCES = [
  { prefix: "ul/", mode: "expanded" as const, shape: LINK_FILE },
  { prefix: undefined, mode: "folded" as const, shape: SIGNED_IN_FILE },
];

type ListedBlob = { url: string; pathname: string; uploadedAt: Date };
type ListPage = { blobs: ListedBlob[]; hasMore: boolean; cursor?: string };
type SweepDb = Pick<typeof prisma, "mediaItem" | "postJob" | "workspace" | "$transaction">;

export interface OrphanSweepResult {
  listed: number;
  deleted: number;
  kept: number;
  failed: number;
  /** False when the time ran out first; tomorrow's run starts again from the top. */
  finished: boolean;
}

/** The candidates' addresses some row refers to exactly. */
async function exactlyReferenced(db: SweepDb, urls: string[]): Promise<Set<string>> {
  const [media, covers, logos] = await Promise.all([
    db.mediaItem.findMany({ where: { storageLocation: { in: urls } }, select: { storageLocation: true } }),
    db.postJob.findMany({ where: { coverImageUrl: { in: urls } }, select: { coverImageUrl: true } }),
    db.workspace.findMany({ where: { logoUrl: { in: urls } }, select: { logoUrl: true } }),
  ]);
  return new Set<string>([
    ...media.map((row) => row.storageLocation),
    ...covers.map((row) => row.coverImageUrl ?? ""),
    ...logos.map((row) => row.logoUrl ?? ""),
  ]);
}

async function deleteUnlessReferenced(
  db: SweepDb,
  blob: ListedBlob,
  del: (url: string, options: { abortSignal: AbortSignal }) => Promise<void>,
): Promise<"deleted" | "kept"> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${guardBlobKey(blob.url)}))`;
      const path = blob.pathname;
      const uses =
        (await tx.mediaItem.count({ where: { storageLocation: { contains: path } } })) +
        (await tx.postJob.count({ where: { coverImageUrl: { contains: path } } })) +
        (await tx.workspace.count({ where: { logoUrl: { contains: path } } }));
      if (uses > 0) return "kept";
      // A reason-less abort, as in mediaBlob.ts: the SDK fails fast on it.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BLOB_DELETE_TIMEOUT_MS);
      try {
        await del(blob.url, { abortSignal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      return "deleted";
    },
    { timeout: BLOB_DELETE_TIMEOUT_MS + 5_000 },
  );
}

export async function sweepOrphanBlobs(
  opts: {
    list?: (options: { prefix?: string; mode: "expanded" | "folded"; cursor?: string; limit: number }) => Promise<ListPage>;
    del?: (url: string, options: { abortSignal: AbortSignal }) => Promise<void>;
    db?: SweepDb;
    now?: () => number;
    budgetMs?: number;
  } = {},
): Promise<OrphanSweepResult> {
  const list = opts.list ?? (blobList as unknown as NonNullable<typeof opts.list>);
  const del = opts.del ?? (blobDel as unknown as NonNullable<typeof opts.del>);
  const db = opts.db ?? prisma;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? ORPHAN_SWEEP_BUDGET_MS);
  const result: OrphanSweepResult = { listed: 0, deleted: 0, kept: 0, failed: 0, finished: false };

  for (const source of SOURCES) {
    let cursor: string | undefined;
    do {
      if (now() >= deadline) return result;
      const page = await list({ prefix: source.prefix, mode: source.mode, cursor, limit: 1000 });
      cursor = page.hasMore ? page.cursor : undefined;
      result.listed += page.blobs.length;

      const cutoff = now() - ORPHAN_MIN_AGE_MS;
      const candidates = page.blobs.filter(
        (blob) => source.shape.test(blob.pathname) && new Date(blob.uploadedAt).getTime() < cutoff,
      );
      if (candidates.length === 0) continue;
      const referenced = await exactlyReferenced(db, candidates.map((blob) => blob.url));
      for (const blob of candidates) {
        if (referenced.has(blob.url)) {
          result.kept += 1;
          continue;
        }
        if (now() >= deadline) return result;
        try {
          const outcome = await deleteUnlessReferenced(db, blob, del);
          result[outcome] += 1;
        } catch (error) {
          result.failed += 1;
          logger.warn("[orphanBlobSweep] Couldn't delete an unregistered upload (tried again tomorrow)", {
            error,
            pathname: blob.pathname,
          });
        }
      }
    } while (cursor);
  }

  result.finished = true;
  return result;
}

/**
 * Daily at 06:25 UTC, a free slot in the cadence map (inngest-functions.ts),
 * one step: one execution a day. SEC: the step output is counts only.
 */
export const orphanBlobSweep = inngest.createFunction(
  {
    id: "orphan-blob-sweep",
    name: "Orphan Blob Sweep",
    singleton: { mode: "skip" },
  },
  { cron: "25 6 * * *" },
  async ({ step }) => {
    const summary = await step.run("sweep", () => sweepOrphanBlobs());
    logger.info("[Inngest] Unregistered uploads swept", summary);
    return summary;
  },
);
