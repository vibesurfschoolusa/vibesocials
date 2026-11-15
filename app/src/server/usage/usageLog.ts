import type { Prisma } from "@prisma/client";

import { BILLING_FIELDS_SELECT, billingEnabled, billingFieldsSelect, planState, type BillingFields } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isOperatorUser } from "@/lib/operator";
import {
  OWNER_DAILY_POST_LIMIT_CODE,
  ownerDailyPostLimit,
  ownerDailyPostLimitMessage,
  personalPostLimitApplies,
  POST_RETRY_LIMIT_CODE,
  postRetryLimitMessage,
  RETRIES_PER_POST_PER_DAY,
  SERVICE_DAILY_POST_LIMIT,
  SERVICE_DAILY_POST_LIMIT_CODE,
  serviceDailyPostLimitAtSendMessage,
  serviceDailyPostLimitMessage,
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
 * it published from (resultClaim.ts), and today's posts are copied inside the
 * deleting transaction. Counts read the live rows and the log together. The numbers and sentences are in
 * src/lib/usageLimits.ts.
 */

export const USAGE_KIND = {
  workspaceCreated: "workspace_created",
  post: "post",
  xPost: "x_post",
  // R6-security M3: one per retry request, counted with the posts.
  retry: "retry",
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
 * R6-security M2: the posts of the day that have gone out, for the service's
 * cap. A post still waiting for its slot is left out, and so is one claimed
 * but not yet given its results (the scanner claims a whole batch at once),
 * so a post scheduled far ahead reserves nothing: it counts once it is sent.
 * Post now and the scanner stamp scheduledFor with the send, so the day is
 * the day it went out.
 */
export function sentOnUtcDayWhere(
  day: Date,
  exclude?: string | readonly string[],
): Prisma.PostJobWhereInput {
  return {
    ...postsOnUtcDayWhere(day, exclude),
    status: { notIn: ["draft", "cancelled", "scheduled"] },
    results: { some: {} },
  };
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
  // R6-security M3: retry rows have no foreign key and stay. Those of a
  // workspace no free limit counts go with it, so a deleted workspace's
  // remaining retries are all ones the service's cap counts.
  const uncapped = workspaces.filter((workspace) => !capped.includes(workspace)).map((workspace) => workspace.id);
  if (uncapped.length > 0) {
    await tx.usageEvent.deleteMany({ where: { kind: USAGE_KIND.retry, workspaceId: { in: uncapped } } });
  }
  if (capped.length === 0) return;
  const personal = new Set(
    capped.filter((workspace) => personalPostLimitApplies(workspace, process.env, now)).map((w) => w.id),
  );
  // Today's retries keep counting toward the deleting person's own total.
  if (personal.size > 0) {
    const { start, end } = utcDayRange(now);
    await tx.usageEvent.updateMany({
      where: { kind: USAGE_KIND.retry, workspaceId: { in: [...personal] }, at: { gte: start, lt: end } },
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

/**
 * Posts and retries on the day in the owner's workspaces that count toward
 * their own total, live and deleted: the live posts, the posts copied from
 * deleted workspaces, and the retries of their workspaces (R6-security M3) or
 * moved to them when a workspace was deleted. One count, so no row twice.
 */
async function ownerPostsOnDay(
  ownerId: string,
  day: Date,
  exclude: string | readonly string[] | undefined,
): Promise<number> {
  const owned = await prisma.workspaceMember.findMany({
    where: { userId: ownerId, role: "owner" },
    select: { workspace: { select: { id: true, ...billingFieldsSelect() } } },
  });
  const ids = owned
    .map((membership) => membership.workspace)
    .filter((workspace: BillingFields & { id: string }) => personalPostLimitApplies(workspace))
    .map((workspace) => workspace.id);
  const { start, end } = utcDayRange(day);
  const [live, logged] = await Promise.all([
    ids.length > 0 ? prisma.postJob.count({ where: { workspaceId: { in: ids }, ...postsOnUtcDayWhere(day, exclude) } }) : 0,
    prisma.usageEvent.count({
      where: {
        at: { gte: start, lt: end },
        OR: [
          { kind: USAGE_KIND.post, userId: ownerId },
          { kind: USAGE_KIND.retry, OR: [{ workspaceId: { in: ids } }, { userId: ownerId }] },
        ],
      },
    }),
  ]);
  return live + logged;
}

/**
 * What the service's cap counts on the day: the posts sent (sentOnUtcDayWhere)
 * and the retries of the workspaces it applies to, plus the posts copied from
 * deleted ones and the retries of deleted ones (deletion keeps only those).
 * Bounded reads: the day's sent posts and retries grouped by workspace, then
 * those workspaces' plan columns and owners; each is decided by
 * serviceCapApplies in code, so the rule is never restated as a query.
 */
async function servicePostsOnDay(
  day: Date,
  exclude: string | readonly string[] | undefined,
  now: Date,
): Promise<number> {
  const { start, end } = utcDayRange(day);
  const [groups, retryGroups, deleted] = await Promise.all([
    prisma.postJob.groupBy({ by: ["workspaceId"], where: sentOnUtcDayWhere(day, exclude), _count: { _all: true } }),
    prisma.usageEvent.groupBy({
      by: ["workspaceId"],
      where: { kind: USAGE_KIND.retry, at: { gte: start, lt: end } },
      _count: { _all: true },
    }),
    prisma.usageEvent.count({ where: { kind: USAGE_KIND.post, at: { gte: start, lt: end } } }),
  ]);
  const ids = [
    ...new Set([...groups.map((group) => group.workspaceId), ...retryGroups.map((group) => group.workspaceId)]),
  ].filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return deleted;

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
  const posts = groups.reduce((sum, group) => (capped.has(group.workspaceId) ? sum + group._count._all : sum), 0);
  const retries = retryGroups.reduce(
    (sum, group) =>
      group.workspaceId && (capped.has(group.workspaceId) || !found.has(group.workspaceId))
        ? sum + group._count._all
        : sum,
    0,
  );
  return deleted + posts + retries;
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
 * The service's cap for one more post or retry on the day. Only posts that went
 * out count (R6-security M2), so a scheduled post meets it when it is sent: a
 * post going out now counts itself and its request's other posts going out
 * with it (`alsoOnDay`); a post given a later slot meets only what has gone
 * out that day already (nothing, for a day still ahead) and is checked again
 * by the scanner when it is due.
 */
async function serviceCapReached(input: {
  workspaceId: string;
  day: Date;
  mode: CrossWorkspaceLimitMode;
  excludePostJobId?: string | readonly string[];
  alsoOnDay: number;
  now: Date;
}): Promise<boolean> {
  if (!serviceCapApplies(await ownBillingFields(input.workspaceId), false, input.now)) return false;
  const goingOut = input.mode === "schedule" ? 0 : input.alsoOnDay;
  return (await servicePostsOnDay(input.day, input.excludePostJobId, input.now)) + goingOut >= SERVICE_DAILY_POST_LIMIT;
}

/**
 * The daily post limits across workspaces, for a post committed to the UTC day
 * of `day` in `workspaceId` (whose billing columns are `workspace`), or for a
 * retry today: each owner's own total (personalPostLimitApplies; the lower
 * number for a new or unconfirmed account), then the service's cap. A
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
  const { workspaceId, day, mode, excludePostJobId } = input;
  const alsoOnDay = input.alsoOnDay ?? 0;
  const now = new Date();

  const owners = await workspaceOwners(workspaceId);
  if (owners.some((owner) => isOperatorUser(owner.user))) return null;

  if (personalPostLimitApplies(input.workspace)) {
    for (const owner of owners) {
      const { limit, reduced } = ownerDailyPostLimit(owner.user, now);
      if ((await ownerPostsOnDay(owner.userId, day, excludePostJobId)) + alsoOnDay >= limit) {
        return { error: ownerDailyPostLimitMessage(limit, mode, reduced), code: OWNER_DAILY_POST_LIMIT_CODE };
      }
    }
  }

  if (await serviceCapReached({ workspaceId, day, mode, excludePostJobId, alsoOnDay, now })) {
    return { error: serviceDailyPostLimitMessage(mode), code: SERVICE_DAILY_POST_LIMIT_CODE };
  }
  return null;
}

/**
 * R6-security M2: the scanner's check as a scheduled post falls due, before
 * its results are made. Only the service's cap: the per-workspace and
 * per-person limits counted the post when it was given its day, and they
 * only ever hold back their own workspaces. What the results then say, or
 * null to send. Fails open, like every usage check: a read error logs and sends.
 */
export async function serviceCapRefusalAtSend(input: {
  workspaceId: string;
  postJobId: string;
  now: Date;
}): Promise<{ errorCode: string; errorMessage: string } | null> {
  try {
    const owners = await workspaceOwners(input.workspaceId);
    if (owners.some((owner) => isOperatorUser(owner.user))) return null;
    const reached = await serviceCapReached({
      workspaceId: input.workspaceId,
      day: input.now,
      mode: "now",
      excludePostJobId: input.postJobId,
      alsoOnDay: 0,
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

const retrySourcePrefix = (postJobId: string) => `${USAGE_KIND.retry}:${postJobId}:`;

/**
 * R6-security M3: why this retry may not run, or null. A post may be retried
 * RETRIES_PER_POST_PER_DAY times a UTC day, and every retry counts with the
 * posts toward the owners' per-person totals and the service's cap (the same
 * rules, crossWorkspacePostRefusal). The operator's workspaces are never
 * refused. Fails open, like the post checks.
 */
export async function retryRefusal(input: {
  workspaceId: string;
  postJobId: string;
  now: Date;
}): Promise<LimitRefusal | null> {
  const { workspaceId, postJobId, now } = input;
  try {
    const owners = await workspaceOwners(workspaceId);
    if (owners.some((owner) => isOperatorUser(owner.user))) return null;

    const { start, end } = utcDayRange(now);
    const retriedToday = await prisma.usageEvent.count({
      where: {
        kind: USAGE_KIND.retry,
        workspaceId,
        sourceId: { startsWith: retrySourcePrefix(postJobId) },
        at: { gte: start, lt: end },
      },
    });
    if (retriedToday >= RETRIES_PER_POST_PER_DAY) {
      return { error: postRetryLimitMessage(RETRIES_PER_POST_PER_DAY), code: POST_RETRY_LIMIT_CODE };
    }

    return await crossWorkspacePostRefusal({
      workspaceId,
      workspace: await ownBillingFields(workspaceId),
      day: now,
      mode: "retry",
    });
  } catch (error) {
    logger.error("[usage] Retry limit check failed; allowing", { error, workspaceId, postJobId });
    return null;
  }
}

/**
 * Records one retry that was handed to the background run, once per request.
 * Its owners' totals find it by workspace (and, once that workspace is
 * deleted, by the userId copyUsageBeforeDeletion gives it). Never throws: the
 * retry is already running.
 */
export async function recordRetry(input: {
  workspaceId: string;
  postJobId: string;
  requestId: string;
  at: Date;
}): Promise<void> {
  try {
    await prisma.usageEvent.create({
      data: {
        kind: USAGE_KIND.retry,
        workspaceId: input.workspaceId,
        sourceId: `${retrySourcePrefix(input.postJobId)}${input.requestId}`,
        at: input.at,
      },
    });
  } catch (error) {
    logger.error("[usage] Couldn't record a retry (ignored)", { error, workspaceId: input.workspaceId });
  }
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
