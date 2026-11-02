import { NextResponse } from "next/server";

import { checkRateLimit } from "@/lib/rateLimit";

/**
 * Shared guards for the three LLM-backed routes (posts/auto-caption,
 * posts/enhance-caption, reviews/draft-response).
 *
 * 2026-11-01 scale audit (W6): those routes accepted unbounded prompt fields,
 * were limited per user only, and called a reasoning model with no timeout.
 * Order in every route: auth -> `findOverlongAiField` -> the existing per-user
 * limit -> `checkWorkspaceAiQuota` -> the provider call.
 */

/** Character caps for prompt fields, plus the per-workspace daily call budget. */
export const AI_LIMITS = {
  /** Free-form caption text (an Instagram caption tops out at 2,200). */
  caption: 2200,
  /** Short enum-like values: platform, language, tone, star rating, mime type. */
  shortField: 40,
  /** A customer review's text. Google reviews run to about 4,096 characters. */
  reviewComment: 5000,
  /** Person and business names. */
  name: 200,
  /** AI calls one workspace may make per 24 h, shared by all three routes. */
  workspaceDailyCalls: 200,
} as const;

/** The provider call is abandoned after this long (-> 504 AI_TIMEOUT). */
export const AI_PROVIDER_TIMEOUT_MS = 20_000;

const WORKSPACE_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Returns the first field whose string value is longer than its `max`, or null
 * when everything fits. Non-strings are ignored: existing type validation owns
 * them (and routes only ever interpolate string values into a prompt).
 */
export function findOverlongAiField(
  fields: Array<{ field: string; value: unknown; max: number }>,
): { field: string; max: number } | null {
  for (const { field, value, max } of fields) {
    if (typeof value === "string" && value.length > max) {
      return { field, max };
    }
  }
  return null;
}

/** `400 { code: "AI_INPUT_TOO_LONG", error }` for a field `findOverlongAiField` flagged. */
export function aiInputTooLongResponse(overlong: { field: string; max: number }): NextResponse {
  return NextResponse.json(
    {
      code: "AI_INPUT_TOO_LONG",
      error: `${overlong.field} is too long (max ${overlong.max} characters).`,
    },
    { status: 400 },
  );
}

/**
 * Counts one AI call against the workspace's daily budget. Shared across all
 * three routes (one key per workspace, not per route) so a workspace cannot
 * multiply its budget by spreading calls over the routes or its members.
 * Fails closed - a limiter outage must not open unlimited LLM spend.
 */
export async function checkWorkspaceAiQuota(
  workspaceId: string,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  return checkRateLimit({
    userId: `ai:workspace:${workspaceId}`,
    route: "ai/workspace-daily",
    limit: AI_LIMITS.workspaceDailyCalls,
    windowMs: WORKSPACE_QUOTA_WINDOW_MS,
    failClosed: true,
  });
}

/** `429 { code: "AI_WORKSPACE_DAILY_LIMIT", error, retryAfterSeconds }` + `Retry-After`. */
export function aiWorkspaceLimitResponse(retryAfterSeconds?: number): NextResponse {
  return NextResponse.json(
    {
      code: "AI_WORKSPACE_DAILY_LIMIT",
      error: "Your workspace has reached today's AI limit. Try again tomorrow.",
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds ?? 1) },
    },
  );
}

/**
 * True for the error a fetch (or a read of its body) throws when its
 * `AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS)` fires (`TimeoutError`) or the
 * signal is aborted by hand (`AbortError`).
 */
export function isAiTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

/** `504 { code: "AI_TIMEOUT", error }`. */
export function aiTimeoutResponse(): NextResponse {
  return NextResponse.json(
    { error: "The AI service took too long. Try again.", code: "AI_TIMEOUT" },
    { status: 504 },
  );
}
