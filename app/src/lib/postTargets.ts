import type { Platform } from "@prisma/client";

import { PLATFORM_ACCEPTED_MEDIA, platformAcceptsMedia, unsupportedMediaReason } from "./platformLimits";
import { platformLabel } from "./platforms";

/**
 * Pure rules for WHICH platforms a post may go to (2026-11-01 audit, Task 9),
 * shared by the composer and `POST /api/posts` so the two can't drift:
 *
 * - media compatibility — a platform whose client rejects the media type is
 *   disabled in the composer and refused / skipped on the server;
 * - ruling R5 — a TikTok privacy level is required whenever TikTok is a target,
 *   for every intent (publish now, schedule, draft).
 *
 * No React, no database: unit-testable in the repo's node environment.
 */

/** Message shown (composer toast / inline) when TikTok lacks a privacy level. */
export const TIKTOK_PRIVACY_REQUIRED_MESSAGE = "Please select a privacy level for TikTok";

export interface PlatformSplit {
  compatible: Platform[];
  incompatible: Platform[];
}

/** Partition `platforms` by whether their client accepts media of `mimeType`. */
export function splitPlatformsByMedia(
  platforms: readonly Platform[],
  mimeType: string | null | undefined,
): PlatformSplit {
  const compatible: Platform[] = [];
  const incompatible: Platform[] = [];
  for (const platform of platforms) {
    (platformAcceptsMedia(platform, mimeType) ? compatible : incompatible).push(platform);
  }
  return { compatible, incompatible };
}

/** What a platform takes, for messages: "video only", "images only", "images or video". */
function acceptedMediaWords(platform: Platform): string {
  const kinds = PLATFORM_ACCEPTED_MEDIA[platform];
  if (kinds.length > 1) return "images or video";
  return kinds[0] === "video" ? "video only" : "images only";
}

/** 400 message naming every platform that can't publish this media. */
export function incompatibleMediaMessage(
  incompatible: readonly Platform[],
  mimeType: string | null | undefined,
): string {
  const named = incompatible
    .map((platform) => `${platformLabel(platform)} (${acceptedMediaWords(platform)})`)
    .join(", ");
  const subject =
    mimeType && mimeType.startsWith("video/")
      ? "a video"
      : mimeType && mimeType.startsWith("image/")
        ? "an image"
        : "this file type";
  return `These platforms can't publish ${subject}: ${named}. Remove them from platforms or choose different media.`;
}

/**
 * Is TikTok a target without an explicit privacy level? "Explicit" means a
 * non-blank string — the empty string the composer starts with is exactly the
 * "not chosen yet" state the client would otherwise silently default to
 * SELF_ONLY at publish time.
 */
export function isTikTokPrivacyMissing(
  targets: readonly Platform[],
  tiktokMetadata: { privacyLevel?: unknown } | null | undefined,
): boolean {
  if (!targets.includes("tiktok")) return false;
  const level = tiktokMetadata?.privacyLevel;
  return !(typeof level === "string" && level.trim().length > 0);
}

export type PostTargetingErrorCode =
  | "PLATFORM_MEDIA_MISMATCH"
  | "NO_COMPATIBLE_PLATFORMS"
  | "TIKTOK_PRIVACY_REQUIRED";

/**
 * Thrown by the pure target checks below. `POST /api/posts` maps it to a 400
 * `{ error, code, platforms }`; `code` lets callers branch without string
 * matching `message`.
 */
export class PostTargetingError extends Error {
  readonly code: PostTargetingErrorCode;
  readonly platforms: Platform[];

  constructor(code: PostTargetingErrorCode, message: string, platforms: Platform[] = []) {
    super(message);
    this.name = "PostTargetingError";
    this.code = code;
    this.platforms = platforms;
  }
}

/**
 * Validate an EXPLICIT `platforms` list against the media and the TikTok rule.
 * No-op when no list was sent (the implicit case is `narrowConnectionsForPost`).
 * Media is checked first: asking for TikTok with an image is a mismatch, not a
 * missing privacy level.
 */
export function assertPostTargetsValid(
  targetPlatforms: readonly Platform[] | undefined,
  mimeType: string | null | undefined,
  tiktokMetadata: { privacyLevel?: unknown } | null | undefined,
): void {
  if (!targetPlatforms) return;

  const { incompatible } = splitPlatformsByMedia(targetPlatforms, mimeType);
  if (incompatible.length > 0) {
    throw new PostTargetingError(
      "PLATFORM_MEDIA_MISMATCH",
      incompatibleMediaMessage(incompatible, mimeType),
      incompatible,
    );
  }

  if (isTikTokPrivacyMissing(targetPlatforms, tiktokMetadata)) {
    throw new PostTargetingError(
      "TIKTOK_PRIVACY_REQUIRED",
      "tiktokMetadata.privacyLevel is required when posting to TikTok.",
      ["tiktok"],
    );
  }
}

/**
 * Which healthy connections an IMMEDIATE post fans out to.
 *
 * - Explicit list: validated by `assertPostTargetsValid`, then the connections
 *   narrowed to it (a listed platform with no healthy connection simply has no
 *   row, as before — the caller's NO_CONNECTIONS covers an empty result).
 * - No list ("every connection", legacy callers): connections whose client
 *   can't publish the media are SKIPPED — no result row, no doomed failure. If
 *   connections exist but none can publish it, `NO_COMPATIBLE_PLATFORMS`. A
 *   compatible TikTok still needs a privacy level (R5).
 *
 * Scheduled/draft posts resolve their fan-out at run time and don't call this.
 */
export function narrowConnectionsForPost<T extends { platform: Platform }>(args: {
  connections: readonly T[];
  targetPlatforms: readonly Platform[] | undefined;
  mimeType: string | null | undefined;
  tiktokMetadata: { privacyLevel?: unknown } | null | undefined;
}): T[] {
  const { connections, targetPlatforms, mimeType, tiktokMetadata } = args;

  if (targetPlatforms) {
    assertPostTargetsValid(targetPlatforms, mimeType, tiktokMetadata);
    return connections.filter((c) => targetPlatforms.includes(c.platform));
  }

  const compatible = connections.filter((c) => platformAcceptsMedia(c.platform, mimeType));
  if (connections.length > 0 && compatible.length === 0) {
    throw new PostTargetingError(
      "NO_COMPATIBLE_PLATFORMS",
      "None of your connected platforms can publish this type of media.",
      connections.map((c) => c.platform),
    );
  }
  if (
    isTikTokPrivacyMissing(
      compatible.map((c) => c.platform),
      tiktokMetadata,
    )
  ) {
    throw new PostTargetingError(
      "TIKTOK_PRIVACY_REQUIRED",
      "tiktokMetadata.privacyLevel is required when posting to TikTok.",
      ["tiktok"],
    );
  }
  return compatible;
}

export interface ComposerPlatformChoice {
  platform: Platform;
  /** Checked = will be published to. Always false when disabled. */
  checked: boolean;
  /** Why the checkbox is disabled (incompatible media), else null. */
  disabledReason: string | null;
}

/**
 * The composer's "Publish to" list, derived from the connected platforms, the
 * user's explicit opt-outs and the chosen media. Platforms the media can't go
 * to render disabled-and-unchecked with a reason. Derived rather than written
 * into state, so choosing different media later restores the user's own choices.
 */
export function deriveComposerPlatforms(
  connected: readonly Platform[],
  deselected: ReadonlySet<Platform>,
  mimeType: string | null | undefined,
): { choices: ComposerPlatformChoice[]; selected: Platform[] } {
  const choices = connected.map((platform): ComposerPlatformChoice => {
    const disabledReason = unsupportedMediaReason(platform, mimeType);
    return {
      platform,
      checked: disabledReason === null && !deselected.has(platform),
      disabledReason,
    };
  });
  return {
    choices,
    selected: choices.filter((c) => c.checked).map((c) => c.platform),
  };
}
