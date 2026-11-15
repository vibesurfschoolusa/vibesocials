import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isOperatorUser } from "@/lib/operator";
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
  /**
   * R5-security M1: AI calls per 24 h across all the workspaces one person
   * owns, so making workspaces does not make AI calls. Two full workspaces'
   * worth: an agency writing and improving captions for several clients a day
   * stays well under it.
   */
  ownerDailyCalls: 400,
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

/** Which budget refused: the workspace's, or one of its owners' across their workspaces. */
export type AiBudget = "workspace" | "owner";

export type AiQuotaResult = { allowed: boolean; retryAfterSeconds?: number; budget?: AiBudget };

type BudgetCounter = { userId: string; route: string; limit: number; budget: AiBudget };

/**
 * The counter key checkRateLimit uses for a window of WORKSPACE_QUOTA_WINDOW_MS
 * (`<userId>:<route>:<bucket>`, src/lib/rateLimit.ts). Read here only to look
 * before spending; spending still goes through checkRateLimit.
 */
function counterKey(counter: BudgetCounter, now: number): string {
  return `${counter.userId}:${counter.route}:${Math.floor(now / WORKSPACE_QUOTA_WINDOW_MS)}`;
}

/**
 * R6-security L3: the first budget already spent, read before any is counted,
 * so a refused call spends none of them. A failed read returns null and the
 * spending below decides (it fails closed).
 */
async function firstSpentBudget(counters: BudgetCounter[], now: number): Promise<AiQuotaResult | null> {
  try {
    const keys = counters.map((counter) => counterKey(counter, now));
    const rows = await prisma.rateLimitEntry.findMany({ where: { key: { in: keys } }, select: { key: true, count: true } });
    const counts = new Map(rows.map((row) => [row.key, row.count]));
    const spent = counters.find((counter, index) => (counts.get(keys[index]) ?? 0) >= counter.limit);
    if (!spent) return null;
    const resetAt = (Math.floor(now / WORKSPACE_QUOTA_WINDOW_MS) + 1) * WORKSPACE_QUOTA_WINDOW_MS;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)), budget: spent.budget };
  } catch (error) {
    logger.warn("[ai] Couldn't read the AI budgets before spending; spending decides", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Counts one AI call against the workspace's daily budget and against each of
 * its owners' budgets across all their workspaces (R5-security M1). Shared
 * across all three routes (one key per workspace and per owner, not per route)
 * so nobody can multiply a budget by spreading calls over the routes, members
 * or workspaces. R6-security L3: every budget is read first, and a call one
 * of them refuses spends none; then each is counted. The counters fail
 * closed - a limiter outage must not open unlimited LLM spend. A failed owner
 * lookup leaves the workspace's budget in charge: it reads the same database,
 * so in an outage it refuses too. The operator's workspaces have no owner
 * budget. A refusal names its budget, for aiWorkspaceLimitResponse.
 */
export async function checkWorkspaceAiQuota(workspaceId: string): Promise<AiQuotaResult> {
  const counters: BudgetCounter[] = [
    {
      userId: `ai:workspace:${workspaceId}`,
      route: "ai/workspace-daily",
      limit: AI_LIMITS.workspaceDailyCalls,
      budget: "workspace",
    },
  ];

  try {
    const owners = await prisma.workspaceMember.findMany({
      where: { workspaceId, role: "owner" },
      select: { userId: true, user: { select: { email: true, emailVerifiedAt: true } } },
    });
    if (!owners.some((owner) => isOperatorUser(owner.user))) {
      for (const owner of owners) {
        counters.push({
          userId: `ai:owner:${owner.userId}`,
          route: "ai/owner-daily",
          limit: AI_LIMITS.ownerDailyCalls,
          budget: "owner",
        });
      }
    }
  } catch (error) {
    logger.error("[ai] Couldn't read the workspace's owners for their AI budget; the workspace budget applies", {
      error,
      workspaceId,
    });
  }

  const spent = await firstSpentBudget(counters, Date.now());
  if (spent) return spent;

  for (const counter of counters) {
    const result = await checkRateLimit({
      userId: counter.userId,
      route: counter.route,
      limit: counter.limit,
      windowMs: WORKSPACE_QUOTA_WINDOW_MS,
      failClosed: true,
    });
    if (!result.allowed) return { ...result, budget: counter.budget };
  }
  return { allowed: true };
}

/** `429 { code: "AI_WORKSPACE_DAILY_LIMIT", error, retryAfterSeconds }` + `Retry-After`. */
export function aiWorkspaceLimitResponse(retryAfterSeconds?: number, budget: AiBudget = "workspace"): NextResponse {
  return NextResponse.json(
    {
      code: "AI_WORKSPACE_DAILY_LIMIT",
      error:
        budget === "owner"
          ? "This workspace's owner has reached today's AI limit across all the workspaces they own. Try again tomorrow."
          : "Your workspace has reached today's AI limit. Try again tomorrow.",
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
