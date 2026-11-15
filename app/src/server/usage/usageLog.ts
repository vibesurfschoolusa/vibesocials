import type { Platform, Prisma } from "@prisma/client";

import { BILLING_FIELDS_SELECT, billingEnabled, billingFieldsSelect, planState, type BillingFields } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isOperatorUser } from "@/lib/operator";
import { platformLabel } from "@/lib/platforms";
import {
  OWNER_DAILY_POST_LIMIT_CODE,
  ownerDailyPostLimit,
  ownerDailyPostLimitMessage,
  ownerDailySendLimitMessage,
  personalPostLimitApplies,
  POST_RETRY_LIMIT_CODE,
  postRetryLimitMessage,
  RETRIES_PER_POST_PER_DAY,
  SERVICE_DAILY_POST_LIMIT,
  SERVICE_DAILY_POST_LIMIT_CODE,
  serviceDailyPostLimitAtSendMessage,
  serviceDailyPostLimitMessage,
  utcDayKey,
  utcDayRange,
  utcMonthRange,
  WORKSPACE_CREATION_LIMIT_CODE,
  WORKSPACES_CREATED_LIMIT,
  WORKSPACES_CREATED_WINDOW_DAYS,
  workspaceCreationLimitMessage,
  type CrossWorkspaceLimitMode,
} from "@/lib/usageLimits";

import type { LimitRefusal } from "./workspaceUsage";

/**
 * R5-security M1 (2026-11-14): the limits that must not multiply with
 * workspaces or start again when one is deleted. A workspace's posts and
 * results cascade with it, so what still counts lives in UsageEvent (no
 * foreign keys): each X post is written with its success, with the X account
 * it published from (resultClaim.ts), each send of a post as it goes out
 * (one per post per UTC day: Post now, the scanner, a retry), and today's
 * posts are copied inside the deleting transaction. The service's cap counts
 * the sends; the per-person totals read the live rows and the log together.
 * The numbers and sentences are in src/lib/usageLimits.ts.
 */

export const USAGE_KIND = {
  workspaceCreated: "workspace_created",
  post: "post",
  xPost: "x_post",
  // R6-security M3: one per platform of a retry request, for the per-platform guard.
  retry: "retry",
  // R6 review of K2: one per post per UTC day it was sent (Post now, the
  // scanner, a retry). The service's cap and the per-person totals count these.
  send: "send",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the service's daily cap applies to a workspace (reviews of
 * R5-security M1): the one rule, used both to refuse and to decide what is
 * counted. The cap protects the Inngest budget from free use, so it leaves
 * out a workspace an operator owns, a grandfathered one (billingExempt, made
 * before billing), and, with billing on, one whose plan planState calls
 * active; those are bounded by their own plan's limits. Free accounts filling
 * a day cannot block them.
 */
export function serviceCapApplies(
  workspace: BillingFields,
  operatorOwned: boolean,
  now: Date,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (operatorOwned || workspace.billingExempt) return false;
  return !billingEnabled(env) || planState(workspace, now) !== "active";
}

/**
 * The posts that count toward the UTC day of `day`: by scheduledFor, else by
 * createdAt, drafts and cancelled posts left out. `exclude` is the post (or
 * both halves of a pair) being moved or published, which must not count
 * against itself. The one rule every daily post count uses.
 */
export function postsOnUtcDayWhere(
  day: Date,
  exclude?: string | readonly string[],
): Prisma.PostJobWhereInput {
  const { start, end } = utcDayRange(day);
  return {
    status: { notIn: ["draft", "cancelled"] },
    ...(typeof exclude === "string" ? { id: { not: exclude } } : {}),
    ...(Array.isArray(exclude) ? { id: { notIn: [...exclude] } } : {}),
    OR: [
      { scheduledFor: { gte: start, lt: end } },
      { scheduledFor: null, createdAt: { gte: start, lt: end } },
    ],
  };
}

/**
 * R6 review of K2: the source id of a post's send on the UTC day of `at`. One
 * per post per day, so a post sent and then retried that day counts once,
 * and a retry on a later day counts once on that day.
 */
export function sendSourceId(postJobId: string, at: Date): string {
  return `${USAGE_KIND.send}:${postJobId}:${utcDayKey(at)}`;
}

/** The post id of a send's source id, or null for anything else. */
function sentPostId(sourceId: string | null): string | null {
  const match = sourceId?.match(/^send:(.+):\d{4}-\d{2}-\d{2}$/);
  return match ? match[1] : null;
}

/**
 * Records that these posts were sent at `at`: the send the daily caps count.
 * Written as each one goes out (Post now, the scanner, a retry), so the next
 * check sees it, and kept when the workspace is deleted (no foreign key).
 * Create-or-skip on the unique sourceId. Answers the posts whose send it wrote
 * (a send already there for the day, from an earlier attempt, is not), so a
 * caller whose hand-over then fails takes back only its own. Never throws:
 * the post is going out.
 */
export async function recordSend(input: {
  workspaceId: string;
  postJobIds: readonly string[];
  at: Date;
}): Promise<string[]> {
  if (input.postJobIds.length === 0) return [];
  try {
    const sourceIds = input.postJobIds.map((postJobId) => sendSourceId(postJobId, input.at));
    const there = new Set(
      (await prisma.usageEvent.findMany({ where: { sourceId: { in: sourceIds } }, select: { sourceId: true } })).map(
        (row) => row.sourceId,
      ),
    );
    const writing = input.postJobIds.filter((postJobId) => !there.has(sendSourceId(postJobId, input.at)));
    if (writing.length === 0) return [];
    await prisma.usageEvent.createMany({
      data: writing.map((postJobId) => ({
        kind: USAGE_KIND.send,
        workspaceId: input.workspaceId,
        sourceId: sendSourceId(postJobId, input.at),
        at: input.at,
      })),
      skipDuplicates: true,
    });
    return writing;
  } catch (error) {
    logger.error("[usage] Couldn't record a send (ignored)", { error, workspaceId: input.workspaceId });
    return [];
  }
}

/** The sends one attempt's recordSend wrote, carried to wherever that attempt is undone. */
export type WrittenSends = { postJobIds: string[]; day: Date };

/**
 * Second and third reviews of K2: a send exists only for a post handed to
 * publishing. Takes back sends an attempt's own recordSend reported writing,
 * when that attempt's hand-over failed or its post had nothing to send; a
 * send already there for the day (a real one, earlier) was never reported,
 * so it is never taken. Never throws.
 */
export async function withdrawSend(input: { postJobIds: readonly string[]; day: Date }): Promise<void> {
  if (input.postJobIds.length === 0) return;
  try {
    await prisma.usageEvent.deleteMany({
      where: {
        kind: USAGE_KIND.send,
        sourceId: { in: input.postJobIds.map((postJobId) => sendSourceId(postJobId, input.day)) },
      },
    });
  } catch (error) {
    logger.error("[usage] Couldn't take back a send (ignored)", { error });
  }
}

/** Who published an X post from where, as the publish step writes it with the result. */
export type XPostUsage = { userId: string; workspaceId: string; accountId: string | null };

/**
 * The usage row of an X post that published (R5-security M1, review): written
 * by the publish step in the same transaction as the success, with the X
 * account it published from, so nothing that happens to the connection or the
 * workspace afterwards can lose it. `sourceId` is the result: once per result.
 */
export function xPostUsageRow(resultId: string, usage: XPostUsage, at: Date) {
  return {
    kind: USAGE_KIND.xPost,
    userId: usage.userId,
    workspaceId: usage.workspaceId,
    platform: "x" as const,
    accountId: usage.accountId,
    sourceId: resultId,
    at,
  };
}

type CreationLogClient = { usageEvent: Pick<Prisma.TransactionClient["usageEvent"], "create"> };

/** In the creating transaction: the workspace counts toward its creator's creations from now on. */
export async function recordWorkspaceCreated(
  tx: CreationLogClient,
  input: { userId: string; workspaceId: string; at: Date },
): Promise<void> {
  await tx.usageEvent.create({
    data: {
      kind: USAGE_KIND.workspaceCreated,
      userId: input.userId,
      workspaceId: input.workspaceId,
      sourceId: `${USAGE_KIND.workspaceCreated}:${input.workspaceId}`,
      at: input.at,
    },
  });
}

/**
 * Why `userId` may not create another workspace now, or null. Every creation
 * in the last WORKSPACES_CREATED_WINDOW_DAYS counts, deleted workspaces too.
 * Fails open, like the usage checks: a read error logs and allows.
 */
export async function workspaceCreationRefusal(userId: string, now: Date): Promise<LimitRefusal | null> {
  try {
    const windowMs = WORKSPACES_CREATED_WINDOW_DAYS * DAY_MS;
    const created = await prisma.usageEvent.findMany({
      where: { kind: USAGE_KIND.workspaceCreated, userId, at: { gt: new Date(now.getTime() - windowMs) } },
      select: { at: true },
      orderBy: { at: "asc" },
    });
    if (created.length < WORKSPACES_CREATED_LIMIT) return null;
    // The next creation is allowed once enough of the oldest have left the window.
    const openAt = new Date(created[created.length - WORKSPACES_CREATED_LIMIT].at.getTime() + windowMs);
    return {
      error: workspaceCreationLimitMessage(WORKSPACES_CREATED_LIMIT, openAt),
      code: WORKSPACE_CREATION_LIMIT_CODE,
    };
  } catch (error) {
    logger.error("[usage] Workspace creation limit check failed; allowing", { error, userId });
    return null;
  }
}

type XCopyClient = {
  postJobResult: Pick<Prisma.TransactionClient["postJobResult"], "findMany">;
  usageEvent: Pick<Prisma.TransactionClient["usageEvent"], "createMany">;
};

/**
 * Copies these workspaces' X posts that published this UTC month into the
 * log, each once (by result id), with the X account that published it when its
 * connection is still there. The publish step writes each new X post itself;
 * this keeps, at a deletion, any written before it did (skipDuplicates leaves
 * the publish step's rows as they are).
 */
async function copyXPosts(db: XCopyClient, workspaceIds: string[], now: Date): Promise<void> {
  const results = await db.postJobResult.findMany({
    where: {
      postJob: { workspaceId: { in: workspaceIds } },
      platform: "x",
      status: "success",
      updatedAt: { gte: utcMonthRange(now).start },
    },
    select: {
      id: true,
      updatedAt: true,
      postJob: { select: { workspaceId: true, userId: true } },
      socialConnection: { select: { accountIdentifier: true } },
    },
  });
  if (results.length === 0) return;
  await db.usageEvent.createMany({
    data: results.map((result) => ({
      kind: USAGE_KIND.xPost,
      userId: result.postJob.userId,
      workspaceId: result.postJob.workspaceId,
      platform: "x" as const,
      accountId: result.socialConnection?.accountIdentifier ?? null,
      sourceId: result.id,
      at: result.updatedAt,
    })),
    skipDuplicates: true,
  });
}

/**
 * X posts this UTC month for the workspace's X account: every post that X
 * account published from any workspace (logged with the account at publish,
 * or still live on its connection), and every X post of this workspace, each
 * counted once. Read-only: the publish step writes the rows (resultClaim.ts),
 * so a disconnect, a deletion or a reconnect elsewhere loses none.
 */
export async function xPostsThisMonth(workspaceId: string, now: Date): Promise<number> {
  const connection = await prisma.socialConnection.findUnique({
    where: { workspaceId_platform: { workspaceId, platform: "x" } },
    select: { accountIdentifier: true },
  });
  const accountId = connection?.accountIdentifier || null;

  // The columns are timestamp(3) holding UTC wall-clock time and Prisma binds
  // a Date as timestamptz, so the start is converted AT TIME ZONE 'UTC' (as
  // the scanner does): the month's boundary never depends on the session zone.
  const start = utcMonthRange(now).start;
  const rows = await prisma.$queryRaw<{ count: bigint | number }[]>`
    SELECT COUNT(*) AS "count" FROM (
      SELECT "sourceId" AS "id" FROM "UsageEvent"
      WHERE "kind" = 'x_post' AND "at" >= ${start}::timestamptz AT TIME ZONE 'UTC'
        AND ("workspaceId" = ${workspaceId} OR "accountId" = ${accountId})
      UNION
      SELECT r."id" FROM "PostJobResult" r
      LEFT JOIN "SocialConnection" c ON c."id" = r."socialConnectionId"
      WHERE r."platform" = 'x' AND r."status" = 'success' AND r."updatedAt" >= ${start}::timestamptz AT TIME ZONE 'UTC'
        AND (r."workspaceId" = ${workspaceId} OR c."accountIdentifier" = ${accountId})
    ) AS "posts"`;
  return Number(rows[0]?.count ?? 0);
}

type DeletionCopyClient = XCopyClient & {
  postJob: Pick<Prisma.TransactionClient["postJob"], "findMany">;
  workspace: Pick<Prisma.TransactionClient["workspace"], "findMany">;
  usageEvent: Pick<Prisma.TransactionClient["usageEvent"], "createMany" | "updateMany" | "deleteMany">;
};

/**
 * Inside the deleting transaction, before the rows go: copies what still
 * counts into the log. Today's posts that went out (or tried to) count for the
 * service's cap, and toward `userId`'s own total when that applied to their
 * workspace; this month's X posts count for their X account. Scheduled posts
 * are left out: deleted with the workspace, they never publish.
 */
export async function copyUsageBeforeDeletion(
  tx: DeletionCopyClient,
  input: { workspaceIds: string[]; userId: string; now: Date },
): Promise<void> {
  const { workspaceIds, userId, now } = input;
  if (workspaceIds.length === 0) return;

  await copyPostsBeforeDeletion(tx, workspaceIds, userId, now);
  await copyXPosts(tx, workspaceIds, now);
}

/** Today's posts of the deleted workspaces the service's cap counts (paying ones count toward no free limit). */
async function copyPostsBeforeDeletion(
  tx: DeletionCopyClient,
  workspaceIds: string[],
  userId: string,
  now: Date,
): Promise<void> {
  const workspaces = await tx.workspace.findMany({
    where: { id: { in: workspaceIds } },
    select: {
      id: true,
      ...BILLING_FIELDS_SELECT,
      members: { where: { role: "owner" }, select: { user: { select: { email: true, emailVerifiedAt: true } } } },
    },
  });
  // Third review: each workspace's own owners decide (still there: the rows go
  // after this), not the deleting person, so an operator-owned workspace a
  // customer co-owner deletes stays out of the count.
  const capped = workspaces.filter((workspace) =>
    serviceCapApplies(workspace, workspace.members.some((owner) => isOperatorUser(owner.user)), now),
  );
  // R6 review of K2: send rows have no foreign key and stay, so the day's
  // count does not drop. Those of a workspace no free limit counts go with
  // it, so a deleted workspace's remaining sends are all ones the cap counts.
  const uncapped = workspaces.filter((workspace) => !capped.includes(workspace)).map((workspace) => workspace.id);
  if (uncapped.length > 0) {
    await tx.usageEvent.deleteMany({ where: { kind: USAGE_KIND.send, workspaceId: { in: uncapped } } });
  }
  if (capped.length === 0) return;
  const personal = new Set(
    capped.filter((workspace) => personalPostLimitApplies(workspace, process.env, now)).map((w) => w.id),
  );
  // Today's sends keep counting toward the deleting person's own total.
  if (personal.size > 0) {
    const { start, end } = utcDayRange(now);
    await tx.usageEvent.updateMany({
      where: { kind: USAGE_KIND.send, workspaceId: { in: [...personal] }, at: { gte: start, lt: end } },
      data: { userId },
    });
  }
  const posts = await tx.postJob.findMany({
    where: {
      workspaceId: { in: capped.map((workspace) => workspace.id) },
      status: { notIn: ["draft", "cancelled", "scheduled"] },
      OR: postsOnUtcDayWhere(now).OR,
    },
    select: { id: true, workspaceId: true, scheduledFor: true, createdAt: true },
  });
  if (posts.length > 0) {
    await tx.usageEvent.createMany({
      data: posts.map((post) => ({
        kind: USAGE_KIND.post,
        userId: personal.has(post.workspaceId) ? userId : null,
        workspaceId: post.workspaceId,
        sourceId: post.id,
        at: post.scheduledFor ?? post.createdAt,
      })),
      skipDuplicates: true,
    });
  }
}

/** The ids of a post, or both halves of a pair, being moved, published or retried. */
function unitIds(exclude: string | readonly string[] | undefined): string[] {
  if (exclude === undefined) return [];
  return typeof exclude === "string" ? [exclude] : [...exclude];
}

/** The owner's free workspaces: those whose posts count toward their own total. */
async function ownerFreeWorkspaceIds(ownerId: string): Promise<string[]> {
  const owned = await prisma.workspaceMember.findMany({
    where: { userId: ownerId, role: "owner" },
    select: { workspace: { select: { id: true, ...billingFieldsSelect() } } },
  });
  return owned
    .map((membership) => membership.workspace)
    .filter((workspace: BillingFields & { id: string }) => personalPostLimitApplies(workspace))
    .map((workspace) => workspace.id);
}

/**
 * Scheduling, moving, approving or posting now (second review of K2): the
 * owner's posts by their slot day, what the calendar shows and the sentence
 * says. The live posts of their free workspaces given that day, and those
 * copied from ones they deleted, each once, other than `unit`.
 */
async function ownerPostsOnDay(ownerId: string, day: Date, unit: readonly string[]): Promise<number> {
  const ids = await ownerFreeWorkspaceIds(ownerId);
  const { start, end } = utcDayRange(day);
  const [live, copied] = await Promise.all([
    ids.length > 0
      ? prisma.postJob.findMany({ where: { workspaceId: { in: ids }, ...postsOnUtcDayWhere(day) }, select: { id: true } })
      : [],
    prisma.usageEvent.findMany({
      where: { kind: USAGE_KIND.post, userId: ownerId, at: { gte: start, lt: end } },
      select: { sourceId: true },
    }),
  ]);
  const posts = new Set(live.map((post) => post.id));
  for (const row of copied) if (row.sourceId) posts.add(row.sourceId);
  for (const id of unit) posts.delete(id);
  return posts.size;
}

/**
 * A retry: the owner's posts sent today (their send rows: their free
 * workspaces', or moved to them when one was deleted), each once, other than
 * `unit`. A retry of a post already sent today adds nothing.
 */
async function ownerSendsOnDay(ownerId: string, day: Date, unit: readonly string[]): Promise<number> {
  const ids = await ownerFreeWorkspaceIds(ownerId);
  const { start, end } = utcDayRange(day);
  const sends = await prisma.usageEvent.findMany({
    where: {
      kind: USAGE_KIND.send,
      at: { gte: start, lt: end },
      OR: [{ workspaceId: { in: ids } }, { userId: ownerId }],
    },
    select: { sourceId: true },
  });
  const posts = new Set(sends.map((row) => sentPostId(row.sourceId)).filter((id): id is string => id !== null));
  for (const id of unit) posts.delete(id);
  return posts.size;
}

/**
 * The sends on the UTC day of `day` that the service's cap counts, other than
 * `unit`'s: those of workspaces it applies to, and those of deleted
 * workspaces (deletion keeps only those). Bounded reads: the day's sends
 * grouped by workspace, then those workspaces' plan columns and owners; each
 * is decided by serviceCapApplies in code, so the rule is never restated as a query.
 */
async function serviceSendsOnDay(day: Date, unit: readonly string[], now: Date): Promise<number> {
  const { start, end } = utcDayRange(day);
  const groups = await prisma.usageEvent.groupBy({
    by: ["workspaceId"],
    where: {
      kind: USAGE_KIND.send,
      at: { gte: start, lt: end },
      ...(unit.length > 0 ? { sourceId: { notIn: unit.map((id) => sendSourceId(id, day)) } } : {}),
    },
    _count: { _all: true },
  });
  const ids = groups.map((group) => group.workspaceId).filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return 0;

  const workspaces = await prisma.workspace.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      ...BILLING_FIELDS_SELECT,
      members: { where: { role: "owner" }, select: { user: { select: { email: true, emailVerifiedAt: true } } } },
    },
  });
  const found = new Set(workspaces.map((workspace) => workspace.id));
  const capped = new Set(
    workspaces
      .filter((workspace) =>
        serviceCapApplies(workspace, workspace.members.some((owner) => isOperatorUser(owner.user)), now),
      )
      .map((workspace) => workspace.id),
  );
  return groups.reduce(
    (sum, group) =>
      group.workspaceId && (capped.has(group.workspaceId) || !found.has(group.workspaceId))
        ? sum + group._count._all
        : sum,
    0,
  );
}

type OwnerRow = { userId: string; user: { email: string; emailVerifiedAt: Date | null; createdAt: Date } };

function workspaceOwners(workspaceId: string): Promise<OwnerRow[]> {
  return prisma.workspaceMember.findMany({
    where: { workspaceId, role: "owner" },
    select: { userId: true, user: { select: { email: true, emailVerifiedAt: true, createdAt: true } } },
  });
}

/** The posting workspace's own plan columns, the flag included: with billing off the caller's row has none of them. */
async function ownBillingFields(workspaceId: string): Promise<BillingFields> {
  return (await prisma.workspace.findUnique({ where: { id: workspaceId }, select: BILLING_FIELDS_SELECT })) ?? {};
}

/**
 * The one rule for the service's cap, shared by Post now (the routes), the
 * scanner and a retry: `size` posts going out on the UTC day of `day` (both
 * halves of a pair: 2) would take the day's sends past the cap. `unit` are
 * their ids when known; their own sends that day are not counted against
 * them, so a half reserved by its pair, or a retry of a post sent today,
 * adds nothing. A day still ahead has no sends.
 */
async function serviceCapReached(input: {
  workspaceId: string;
  day: Date;
  unit: readonly string[];
  size: number;
  now: Date;
}): Promise<boolean> {
  if (!serviceCapApplies(await ownBillingFields(input.workspaceId), false, input.now)) return false;
  return (await serviceSendsOnDay(input.day, input.unit, input.now)) + input.size > SERVICE_DAILY_POST_LIMIT;
}

/**
 * The daily post limits across workspaces, for a post committed to the UTC day
 * of `day` in `workspaceId` (whose billing columns are `workspace`), or for a
 * retry today: each owner's own total (personalPostLimitApplies; the lower
 * number for a new or unconfirmed account; their posts by slot day, or for a
 * retry their sends today), then the service's cap. A
 * workspace any operator owns is never refused here. Throws on a database
 * error; checkDailyPostLimit fails open around it.
 */
export async function crossWorkspacePostRefusal(input: {
  workspaceId: string;
  workspace: BillingFields;
  day: Date;
  mode: CrossWorkspaceLimitMode;
  excludePostJobId?: string | readonly string[];
  alsoOnDay?: number;
}): Promise<LimitRefusal | null> {
  const { workspaceId, day, mode } = input;
  const unit = unitIds(input.excludePostJobId);
  const size = 1 + (input.alsoOnDay ?? 0);
  const now = new Date();

  const owners = await workspaceOwners(workspaceId);
  if (owners.some((owner) => isOperatorUser(owner.user))) return null;

  if (personalPostLimitApplies(input.workspace)) {
    for (const owner of owners) {
      const { limit, reduced } = ownerDailyPostLimit(owner.user, now);
      if (mode === "retry") {
        if ((await ownerSendsOnDay(owner.userId, day, unit)) + size > limit) {
          return { error: ownerDailySendLimitMessage(limit, reduced), code: OWNER_DAILY_POST_LIMIT_CODE };
        }
      } else if ((await ownerPostsOnDay(owner.userId, day, unit)) + size > limit) {
        return { error: ownerDailyPostLimitMessage(limit, mode, reduced), code: OWNER_DAILY_POST_LIMIT_CODE };
      }
    }
  }

  // A post given a later slot meets the cap when it is sent (the scanner);
  // now it meets only what has gone out on its day already.
  const sending = mode === "schedule" ? 1 : size;
  if (await serviceCapReached({ workspaceId, day, unit, size: sending, now })) {
    return { error: serviceDailyPostLimitMessage(mode), code: SERVICE_DAILY_POST_LIMIT_CODE };
  }
  return null;
}

/**
 * R6-security M2: the scanner's check as a scheduled post falls due, before
 * its results are made: the post, or both halves of a Feed and Story pair as
 * one unit (sent together or not at all). Only the service's cap: the
 * per-workspace and per-person limits counted the post when it was given its
 * day, and they only ever hold back their own workspaces. What the results
 * then say, or null to send. Fails open, like every usage check.
 */
export async function serviceCapRefusalAtSend(input: {
  workspaceId: string;
  postJobIds: readonly string[];
  now: Date;
}): Promise<{ errorCode: string; errorMessage: string } | null> {
  try {
    const owners = await workspaceOwners(input.workspaceId);
    if (owners.some((owner) => isOperatorUser(owner.user))) return null;
    const reached = await serviceCapReached({
      workspaceId: input.workspaceId,
      day: input.now,
      unit: input.postJobIds,
      size: input.postJobIds.length,
      now: input.now,
    });
    return reached
      ? { errorCode: SERVICE_DAILY_POST_LIMIT_CODE, errorMessage: serviceDailyPostLimitAtSendMessage() }
      : null;
  } catch (error) {
    logger.error("[usage] Service cap check at send failed; sending", { error, workspaceId: input.workspaceId });
    return null;
  }
}

const retrySourcePrefix = (postJobId: string, platform: Platform) => `${USAGE_KIND.retry}:${postJobId}:${platform}:`;

/**
 * R6-security M3 and the review of K2: why this retry may not run, or null.
 * Each platform of a post may be retried RETRIES_PER_POST_PER_DAY times a UTC
 * day (it only stops a platform that keeps failing, so it applies to paying
 * workspaces too); then the retry counts toward the owners' per-person totals
 * and the service's cap as one send of the post (crossWorkspacePostRefusal),
 * which paying workspaces are never refused by. The operator's workspaces are
 * never refused. Fails open, like the post checks.
 */
export async function retryRefusal(input: {
  workspaceId: string;
  postJobId: string;
  platforms: readonly Platform[];
  now: Date;
}): Promise<LimitRefusal | null> {
  const { workspaceId, postJobId, now } = input;
  try {
    const owners = await workspaceOwners(workspaceId);
    if (owners.some((owner) => isOperatorUser(owner.user))) return null;

    const { start, end } = utcDayRange(now);
    for (const platform of input.platforms) {
      const retriedToday = await prisma.usageEvent.count({
        where: {
          kind: USAGE_KIND.retry,
          workspaceId,
          sourceId: { startsWith: retrySourcePrefix(postJobId, platform) },
          at: { gte: start, lt: end },
        },
      });
      if (retriedToday >= RETRIES_PER_POST_PER_DAY) {
        return {
          error: postRetryLimitMessage(RETRIES_PER_POST_PER_DAY, platformLabel(platform)),
          code: POST_RETRY_LIMIT_CODE,
        };
      }
    }

    return await crossWorkspacePostRefusal({
      workspaceId,
      workspace: await ownBillingFields(workspaceId),
      day: now,
      mode: "retry",
      excludePostJobId: postJobId,
    });
  } catch (error) {
    logger.error("[usage] Retry limit check failed; allowing", { error, workspaceId, postJobId });
    return null;
  }
}

/**
 * Records one retry that was handed to the background run: a row per platform
 * it includes (the per-platform guard), and the post's send for the day (the
 * caps: once per post per day, however many platforms or requests). Never
 * throws: the retry is already running.
 */
export async function recordRetry(input: {
  workspaceId: string;
  postJobId: string;
  platforms: readonly Platform[];
  requestId: string;
  at: Date;
}): Promise<void> {
  try {
    await prisma.usageEvent.createMany({
      data: input.platforms.map((platform) => ({
        kind: USAGE_KIND.retry,
        workspaceId: input.workspaceId,
        platform,
        sourceId: `${retrySourcePrefix(input.postJobId, platform)}${input.requestId}`,
        at: input.at,
      })),
      skipDuplicates: true,
    });
  } catch (error) {
    logger.error("[usage] Couldn't record a retry (ignored)", { error, workspaceId: input.workspaceId });
  }
  await recordSend({ workspaceId: input.workspaceId, postJobIds: [input.postJobId], at: input.at });
}

/**
 * How long a usage row is kept (review): the longest window any limit counts
 * is a month (X posts; the creation limit is 30 days), so 62 days keeps two
 * months with room, and nothing older is ever read.
 */
export const USAGE_EVENT_RETENTION_DAYS = 62;

/**
 * Deletes usage rows no limit can still count. Run inside the daily orphan
 * blob sweep's one step (no new function or step). Never throws: a failure is
 * logged and tried again the next day. Answers how many rows went.
 */
export async function pruneUsageEvents(now: Date): Promise<number> {
  try {
    const { count } = await prisma.usageEvent.deleteMany({
      where: { at: { lt: new Date(now.getTime() - USAGE_EVENT_RETENTION_DAYS * DAY_MS) } },
    });
    return count;
  } catch (error) {
    logger.error("[usage] Couldn't prune old usage rows (tried again tomorrow)", { error });
    return 0;
  }
}
