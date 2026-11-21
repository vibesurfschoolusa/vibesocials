import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isOperatorUser } from "@/lib/operator";
import { checkRateLimit } from "@/lib/rateLimit";
import { personLabel } from "@/lib/usageLimits";

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

/**
 * R46 pages-a L1 (second half): what each field a person types is called in
 * the refusal, and the step that works next. Create shows the sentence word
 * for word, so it never names a field the way the code does.
 */
const AI_FIELD_WORDS: Record<string, { what: string; step: string }> = {
  caption: { what: "This caption", step: "Your caption is unchanged. Shorten it, or edit it yourself." },
  comment: { what: "This review", step: "Write the reply yourself." },
  reviewerName: { what: "The reviewer's name", step: "Write the reply yourself." },
  businessName: { what: "The business name", step: "Write the reply yourself." },
  tone: { what: "The tone", step: "Shorten it, then try again." },
  language: { what: "The language", step: "Shorten it, then try again." },
  blobUrl: { what: "This photo's address", step: "Write the caption yourself, or upload the photo again." },
};

/** The refusal for a field nobody types (platform, mime type, star rating): only a changed page sends one. */
const AI_REQUEST_TOO_LONG = "The AI couldn't take this request: part of it is too long. Reload the page, then try again.";

/** The one sentence for a field `findOverlongAiField` flagged. */
export function aiInputTooLongMessage(field: string, max: number): string {
  const words = Object.hasOwn(AI_FIELD_WORDS, field) ? AI_FIELD_WORDS[field] : undefined;
  if (!words) return AI_REQUEST_TOO_LONG;
  return `${words.what} is too long for the AI (${max.toLocaleString("en-US")} characters at most). ${words.step}`;
}

/** `400 { code: "AI_INPUT_TOO_LONG", error }` for a field `findOverlongAiField` flagged. */
export function aiInputTooLongResponse(overlong: { field: string; max: number }): NextResponse {
  return NextResponse.json(
    {
      code: "AI_INPUT_TOO_LONG",
      error: aiInputTooLongMessage(overlong.field, overlong.max),
    },
    { status: 400 },
  );
}

/** Which budget refused: the workspace's, or one of its owners' across their workspaces. */
export type AiBudget = "workspace" | "owner";

/**
 * R56 pages-a-4 L3: the owner whose budget refused, read from the workspace's
 * own owners (never the request), and every owner's id, so the sentence can
 * say "You" to them and name them to a co-owner.
 */
export type AiSpentOwner = { userId: string; name: string | null; email: string; ownerUserIds: string[] };

/** `unavailable`: a counter store that couldn't answer (fail closed); the caller answers limitUncheckedResponse. */
export type AiQuotaResult = {
  allowed: boolean;
  retryAfterSeconds?: number;
  budget?: AiBudget;
  spentOwner?: AiSpentOwner;
  unavailable?: true;
};

type BudgetCounter = { userId: string; route: string; limit: number; budget: AiBudget; owner?: AiSpentOwner };

/** The refusal for a spent counter; an owner's carries which owner it is. */
function refusalFor(counter: BudgetCounter, retryAfterSeconds: number | undefined): AiQuotaResult {
  return {
    allowed: false,
    retryAfterSeconds,
    budget: counter.budget,
    ...(counter.owner ? { spentOwner: counter.owner } : {}),
  };
}

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
    return refusalFor(spent, Math.max(1, Math.ceil((resetAt - now) / 1000)));
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
      select: { userId: true, user: { select: { email: true, emailVerifiedAt: true, name: true } } },
    });
    if (!owners.some((owner) => isOperatorUser(owner.user))) {
      const ownerUserIds = owners.map((owner) => owner.userId);
      for (const owner of owners) {
        counters.push({
          userId: `ai:owner:${owner.userId}`,
          route: "ai/owner-daily",
          limit: AI_LIMITS.ownerDailyCalls,
          budget: "owner",
          owner: { userId: owner.userId, name: owner.user.name ?? null, email: owner.user.email, ownerUserIds },
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
    if (!result.allowed) return { ...result, ...refusalFor(counter, result.retryAfterSeconds) };
  }
  return { allowed: true };
}

/**
 * R45 pages-a L4: when the spent budget resets. The budgets are counted per UTC
 * day, so "tomorrow" was untrue for most readers; the wait is rounded up, so
 * trying again when it says never fails.
 */
function aiLimitResetsText(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return "It resets at midnight UTC.";
  }
  const minutes = Math.ceil(retryAfterSeconds / 60);
  if (minutes <= 1) return "It resets in a minute.";
  if (minutes < 60) return `It resets in ${minutes} minutes.`;
  const hours = Math.ceil(retryAfterSeconds / 3600);
  return hours === 1 ? "It resets in 1 hour." : `It resets in ${hours} hours.`;
}

/**
 * Whose budget is spent. R56 pages-a-4 L3: as the per-person post limit
 * (R7 point 6, R8-pages L3), "You" to the spent owner, and their name to
 * anyone else in a co-owned workspace, so a co-owner who used none isn't
 * told the owner is spent.
 */
function aiLimitReason(budget: AiBudget, spentOwner: AiSpentOwner | undefined, readerUserId: string | undefined): string {
  if (budget !== "owner") return "This workspace has reached today's AI limit.";
  if (spentOwner && readerUserId === spentOwner.userId) {
    return "You have reached today's AI limit across the workspaces you own.";
  }
  if (spentOwner && spentOwner.ownerUserIds.length > 1) {
    const readerIsOwner = readerUserId !== undefined && spentOwner.ownerUserIds.includes(readerUserId);
    const name = personLabel(spentOwner, readerIsOwner);
    return `${name}, an owner of this workspace, has reached today's AI limit across the workspaces they own.`;
  }
  return "This workspace's owner has reached today's AI limit across all the workspaces they own.";
}

/** `429 { code: "AI_WORKSPACE_DAILY_LIMIT", budget, error, retryAfterSeconds }` + `Retry-After`. */
export function aiWorkspaceLimitResponse(
  retryAfterSeconds?: number,
  budget: AiBudget = "workspace",
  spentOwner?: AiSpentOwner,
  readerUserId?: string,
): NextResponse {
  const reason = aiLimitReason(budget, spentOwner, readerUserId);
  return NextResponse.json(
    {
      code: "AI_WORKSPACE_DAILY_LIMIT",
      budget,
      error: `${reason} ${aiLimitResetsText(retryAfterSeconds)}`,
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
