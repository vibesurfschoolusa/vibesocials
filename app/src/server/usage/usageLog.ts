import type { Prisma } from "@prisma/client";

import { billingEnabled, billingFieldsSelect, PAST_DUE_GRACE_DAYS, planState, type BillingFields } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isOperatorUser, parseAdminEmails } from "@/lib/operator";
import {
  OWNER_DAILY_POST_LIMIT,
  OWNER_DAILY_POST_LIMIT_CODE,
  ownerDailyPostLimitMessage,
  personalPostLimitApplies,
  SERVICE_DAILY_POST_LIMIT,
  SERVICE_DAILY_POST_LIMIT_CODE,
  serviceDailyPostLimitMessage,
  utcDayRange,
  utcMonthRange,
  WORKSPACE_CREATION_LIMIT_CODE,
  WORKSPACES_CREATED_LIMIT,
  WORKSPACES_CREATED_WINDOW_DAYS,
  workspaceCreationLimitMessage,
  type DailyPostLimitMode,
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
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the service's daily cap applies to a workspace (review of
 * R5-security M1): it protects the Inngest budget from free use, so a paying
 * workspace (billing on, plan active) is bounded by its plan's limits only,
 * and free accounts filling a day cannot block it. The operator's workspaces
 * are left out by the caller.
 */
function serviceCapApplies(workspace: BillingFields, now: Date): boolean {
  return !billingEnabled() || planState(workspace, now) !== "active";
}

/**
 * planState's "active", as a query: the workspaces that pay for a plan. Kept
 * in step with src/lib/billing.ts planState (not exempt by flag; a plan that is
 * active or trialing, or past_due within the grace after its period end).
 */
function payingWorkspaceWhere(now: Date): Prisma.WorkspaceWhereInput {
  return {
    billingExempt: false,
    plan: { not: null },
    OR: [
      { planStatus: { in: ["active", "trialing"] } },
      { planStatus: "past_due", currentPeriodEnd: { gt: new Date(now.getTime() - PAST_DUE_GRACE_DAYS * DAY_MS) } },
    ],
  };
}

/** The workspaces the service's cap counts: no verified operator among the owners, and (billing on) not paying. */
function serviceCapWorkspaceWhere(now: Date): Prisma.WorkspaceWhereInput {
  const operators = [...parseAdminEmails(process.env.ADMIN_EMAILS)];
  return {
    ...(operators.length > 0
      ? { members: { none: { role: "owner", user: { email: { in: operators }, emailVerifiedAt: { not: null } } } } }
      : {}),
    ...(billingEnabled() ? { NOT: payingWorkspaceWhere(now) } : {}),
  };
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

  const start = utcMonthRange(now).start;
  const rows = await prisma.$queryRaw<{ count: bigint | number }[]>`
    SELECT COUNT(*) AS "count" FROM (
      SELECT "sourceId" AS "id" FROM "UsageEvent"
      WHERE "kind" = 'x_post' AND "at" >= ${start}
        AND ("workspaceId" = ${workspaceId} OR "accountId" = ${accountId})
      UNION
      SELECT r."id" FROM "PostJobResult" r
      LEFT JOIN "SocialConnection" c ON c."id" = r."socialConnectionId"
      WHERE r."platform" = 'x' AND r."status" = 'success' AND r."updatedAt" >= ${start}
        AND (r."workspaceId" = ${workspaceId} OR c."accountIdentifier" = ${accountId})
    ) AS "posts"`;
  return Number(rows[0]?.count ?? 0);
}

type DeletionCopyClient = XCopyClient & {
  postJob: Pick<Prisma.TransactionClient["postJob"], "findMany">;
  workspace: Pick<Prisma.TransactionClient["workspace"], "findMany">;
  usageEvent: Pick<Prisma.TransactionClient["usageEvent"], "createMany">;
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
  // `operator`: the deleting person is an operator, whose posts count toward no limit.
  input: { workspaceIds: string[]; userId: string; operator: boolean; now: Date },
): Promise<void> {
  const { workspaceIds, userId, now } = input;
  if (workspaceIds.length === 0) return;

  if (!input.operator) {
    await copyPostsBeforeDeletion(tx, workspaceIds, userId, now);
  }
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
    select: { id: true, ...billingFieldsSelect() },
  });
  const capped = workspaces.filter((workspace) => serviceCapApplies(workspace, now));
  if (capped.length === 0) return;
  const personal = new Set(
    capped.filter((workspace) => personalPostLimitApplies(workspace, process.env, now)).map((w) => w.id),
  );
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

/** Posts on the day in the owner's workspaces that count toward their own total, live and deleted. */
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
  const [live, deleted] = await Promise.all([
    ids.length > 0 ? prisma.postJob.count({ where: { workspaceId: { in: ids }, ...postsOnUtcDayWhere(day, exclude) } }) : 0,
    prisma.usageEvent.count({ where: { kind: USAGE_KIND.post, userId: ownerId, at: { gte: start, lt: end } } }),
  ]);
  return live + deleted;
}

/** The posts on the day the service's cap counts, live and deleted (deletion copies only those). */
async function servicePostsOnDay(day: Date, exclude: string | readonly string[] | undefined): Promise<number> {
  const { start, end } = utcDayRange(day);
  const [live, deleted] = await Promise.all([
    prisma.postJob.count({ where: { ...postsOnUtcDayWhere(day, exclude), workspace: serviceCapWorkspaceWhere(new Date()) } }),
    prisma.usageEvent.count({ where: { kind: USAGE_KIND.post, at: { gte: start, lt: end } } }),
  ]);
  return live + deleted;
}

/**
 * The daily post limits across workspaces, for a post committed to the UTC day
 * of `day` in `workspaceId` (whose billing columns are `workspace`): each
 * owner's own total while billing is off or the workspace is on its trial, then
 * the service's cap. A workspace any operator owns is never refused here.
 * Throws on a database error; checkDailyPostLimit fails open around it.
 */
export async function crossWorkspacePostRefusal(input: {
  workspaceId: string;
  workspace: BillingFields;
  day: Date;
  mode: DailyPostLimitMode;
  excludePostJobId?: string | readonly string[];
  alsoOnDay?: number;
}): Promise<LimitRefusal | null> {
  const { workspaceId, day, mode, excludePostJobId } = input;
  const alsoOnDay = input.alsoOnDay ?? 0;

  const owners = await prisma.workspaceMember.findMany({
    where: { workspaceId, role: "owner" },
    select: { userId: true, user: { select: { email: true, emailVerifiedAt: true } } },
  });
  if (owners.some((owner) => isOperatorUser(owner.user))) return null;

  if (personalPostLimitApplies(input.workspace)) {
    for (const owner of owners) {
      if ((await ownerPostsOnDay(owner.userId, day, excludePostJobId)) + alsoOnDay >= OWNER_DAILY_POST_LIMIT) {
        return { error: ownerDailyPostLimitMessage(OWNER_DAILY_POST_LIMIT, mode), code: OWNER_DAILY_POST_LIMIT_CODE };
      }
    }
  }

  if (
    serviceCapApplies(input.workspace, new Date()) &&
    (await servicePostsOnDay(day, excludePostJobId)) + alsoOnDay >= SERVICE_DAILY_POST_LIMIT
  ) {
    return { error: serviceDailyPostLimitMessage(mode), code: SERVICE_DAILY_POST_LIMIT_CODE };
  }
  return null;
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
