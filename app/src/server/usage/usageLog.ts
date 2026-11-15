import type { Prisma } from "@prisma/client";

import { BILLING_FIELDS_SELECT, billingEnabled, billingFieldsSelect, planState, type BillingFields } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isOperatorUser } from "@/lib/operator";
import {
  GUARANTEED_RUNS_PER_PERSON,
  isNewAccount,
  NEW_ACCOUNT_POOL_DAILY_LIMIT,
  newAccountPoolAtSendMessage,
  newAccountPoolMessage,
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
 * it published from (resultClaim.ts), and each run (R7-security L1: a post
 * going out, or one retry request) as it is handed over, with the pool it
 * drew from and the workspace's owners at that time (R7-security M1). The
 * pools and the per-person numbers count the runs. The numbers and sentences
 * are in src/lib/usageLimits.ts.
 */

export const USAGE_KIND = {
  workspaceCreated: "workspace_created",
  post: "post",
  xPost: "x_post",
  // R6-security M3: one per platform of a retry request. Written before
  // R7-security L1 only; the retry guard still reads today's, by request.
  retry: "retry",
  // R7-security L1: one per run: a post going out (Post now, the scanner) or
  // one retry request. The pools and the per-person numbers count these.
  send: "send",
} as const;

/**
 * R7-security M1: the pool a run draws from, recorded on its row. "none" is a
 * run no pool counts (paying, grandfathered or the operator's workspaces).
 */
export const RUN_POOL = { main: "main", newAccounts: "new", none: "none" } as const;
export type RunPool = (typeof RUN_POOL)[keyof typeof RUN_POOL];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the service's daily pools apply to a workspace (reviews of
 * R5-security M1): the one rule, used both to refuse and to decide what is
 * counted. The pools protect the Inngest budget from free use, so they leave
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
 * The source id of a post's run as it goes out on the UTC day of `at`. A post
 * goes out once (a re-run of the same hand-over finds the row and writes no
 * second), so this is one row per run; a retry has its own id per request.
 */
export function sendSourceId(postJobId: string, at: Date): string {
  return `${USAGE_KIND.send}:${postJobId}:${utcDayKey(at)}`;
}

const retryRunPrefix = (postJobId: string) => `${USAGE_KIND.send}:${postJobId}:retry:`;

/** R7-security L1: the source id of one retry request's run. */
export function retrySourceId(postJobId: string, requestId: string): string {
  return `${retryRunPrefix(postJobId)}${requestId}`;
}

type OwnerRow = {
  userId: string;
  user: { email: string; name?: string | null; emailVerifiedAt: Date | null; createdAt: Date };
};

function workspaceOwners(workspaceId: string): Promise<OwnerRow[]> {
  return prisma.workspaceMember.findMany({
    where: { workspaceId, role: "owner" },
    select: { userId: true, user: { select: { email: true, name: true, emailVerifiedAt: true, createdAt: true } } },
  });
}

/** The posting workspace's own plan columns, the flag included: with billing off the caller's row has none of them. */
async function ownBillingFields(workspaceId: string): Promise<BillingFields> {
  return (await prisma.workspace.findUnique({ where: { id: workspaceId }, select: BILLING_FIELDS_SELECT })) ?? {};
}

/** Confirmed and a day old at `at`: draws from the main pool, with its guaranteed share. */
function established(owner: OwnerRow, at: Date): boolean {
  return !isNewAccount(owner.user, at);
}

/**
 * R7-security M1: who a run of a workspace at a moment is: its owners then,
 * the pool it draws from, and whose per-person number it counts toward. The
 * operator's workspaces and those the pools leave out (serviceCapApplies)
 * draw from none; one with at least one confirmed, day-old owner from the
 * main pool; any other from the new-account pool.
 */
type RunAttribution = { owners: OwnerRow[]; operator: boolean; pool: RunPool; ownerIds: string[] };

async function runAttribution(workspaceId: string, at: Date): Promise<RunAttribution> {
  const owners = await workspaceOwners(workspaceId);
  if (owners.some((owner) => isOperatorUser(owner.user))) {
    return { owners, operator: true, pool: RUN_POOL.none, ownerIds: [] };
  }
  const fields = await ownBillingFields(workspaceId);
  const pool = !serviceCapApplies(fields, false, at)
    ? RUN_POOL.none
    : owners.some((owner) => established(owner, at))
      ? RUN_POOL.main
      : RUN_POOL.newAccounts;
  const ownerIds = personalPostLimitApplies(fields, process.env, at) ? owners.map((owner) => owner.userId) : [];
  return { owners, operator: false, pool, ownerIds };
}

/**
 * The rows of runs of one workspace at `at`, each saying who it is. When that
 * cannot be read the row is still written, with no pool: the older rule then
 * counts it (the main pool, the workspace's owners at the time of the check).
 */
async function runRows(workspaceId: string, sourceIds: readonly string[], at: Date) {
  let who: RunAttribution | null = null;
  try {
    who = await runAttribution(workspaceId, at);
  } catch (error) {
    logger.error("[usage] Couldn't read a run's owners; recording it without them", { error, workspaceId });
  }
  return sourceIds.map((sourceId) => ({
    kind: USAGE_KIND.send,
    workspaceId,
    sourceId,
    at,
    pool: who?.pool ?? null,
    ownerIds: who?.ownerIds ?? [],
  }));
}

/**
 * Records that these posts went out at `at`: one run each, which the pools and
 * the per-person numbers count. Written as each one goes out (Post now, the
 * scanner), so the next check sees it, and kept when the workspace is deleted
 * (no foreign key). Create-or-skip on the unique sourceId. Answers the posts
 * whose run it wrote (one already there, from an earlier attempt of the same
 * hand-over, is not), so a caller whose hand-over then fails takes back only
 * its own. Never throws: the post is going out.
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
      data: await runRows(
        input.workspaceId,
        writing.map((postJobId) => sendSourceId(postJobId, input.at)),
        input.at,
      ),
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
 * Second and third reviews of K2: a run exists only for a post handed to
 * publishing. Takes back runs an attempt's own recordSend reported writing,
 * when that attempt's hand-over failed or its post had nothing to send; one
 * already there (a real one, earlier) was never reported, so it is never
 * taken. Never throws.
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
  // count does not drop. R7-security M1: a run's row says its pool and owners
  // itself; only rows written before that (no pool) are decided by the
  // workspace, so those of a workspace no free limit counts go with it.
  const uncapped = workspaces.filter((workspace) => !capped.includes(workspace)).map((workspace) => workspace.id);
  if (uncapped.length > 0) {
    await tx.usageEvent.deleteMany({ where: { kind: USAGE_KIND.send, pool: null, workspaceId: { in: uncapped } } });
  }
  if (capped.length === 0) return;
  const personal = new Set(
    capped.filter((workspace) => personalPostLimitApplies(workspace, process.env, now)).map((w) => w.id),
  );
  // Today's runs written before pools keep counting toward the deleting
  // person's own total; newer rows carry their owners.
  if (personal.size > 0) {
    const { start, end } = utcDayRange(now);
    await tx.usageEvent.updateMany({
      where: { kind: USAGE_KIND.send, pool: null, workspaceId: { in: [...personal] }, at: { gte: start, lt: end } },
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

/** The owner's free workspaces now: whose scheduled posts count toward their own number. */
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

/** A unit's own runs on `day`, which never count against it (a half its pair reserved). */
function unitSourceIds(unit: readonly string[], day: Date): string[] {
  return unit.map((id) => sendSourceId(id, day));
}

/**
 * R7-security M1 (d): the runs on the UTC day of `day` that count toward
 * `ownerId`: those recorded with them as an owner at the time of the run, so
 * leaving, handing over or deleting a workspace lowers nothing. Rows written
 * before that carry no owners and count by the older rule: the owner's free
 * workspaces now, or moved to them when one was deleted.
 */
async function ownerRunsOnDay(
  ownerId: string,
  day: Date,
  unit: readonly string[],
  freeIds: readonly string[],
): Promise<number> {
  const { start, end } = utcDayRange(day);
  const rows = await prisma.usageEvent.findMany({
    where: {
      kind: USAGE_KIND.send,
      at: { gte: start, lt: end },
      OR: [
        { ownerIds: { has: ownerId } },
        { pool: null, workspaceId: { in: [...freeIds] } },
        { pool: null, userId: ownerId },
      ],
    },
    select: { sourceId: true },
  });
  const own = new Set(unitSourceIds(unit, day));
  return new Set(rows.map((row) => row.sourceId).filter((id) => id !== null && !own.has(id))).size;
}

/**
 * One owner's number for the UTC day of `day`: the runs that counted toward
 * them that day, plus their free workspaces' posts given that day that have
 * not gone out yet (the calendar), other than `unit`. A day ahead has only the
 * calendar; today has what ran and what is still to go.
 */
async function ownerCountOnDay(ownerId: string, day: Date, unit: readonly string[]): Promise<number> {
  const freeIds = await ownerFreeWorkspaceIds(ownerId);
  const [runs, waiting] = await Promise.all([
    ownerRunsOnDay(ownerId, day, unit, freeIds),
    freeIds.length > 0
      ? prisma.postJob.findMany({
          where: { workspaceId: { in: freeIds }, ...postsOnUtcDayWhere(day, unit), status: "scheduled" },
          select: { id: true },
        })
      : [],
  ]);
  return runs + waiting.length;
}

/**
 * The runs on the UTC day of `day` in each pool, other than `unit`'s. A row
 * says its pool; one written before pools counts in the main pool when its
 * workspace is one the pools apply to now, or is deleted (deletion keeps only
 * those), as before. Bounded reads: the day's rows grouped by workspace and
 * pool, then only the older rows' workspaces.
 */
async function poolRunsOnDay(
  day: Date,
  unit: readonly string[],
  now: Date,
): Promise<{ main: number; newAccounts: number }> {
  const { start, end } = utcDayRange(day);
  const groups = await prisma.usageEvent.groupBy({
    by: ["workspaceId", "pool"],
    where: {
      kind: USAGE_KIND.send,
      at: { gte: start, lt: end },
      ...(unit.length > 0 ? { sourceId: { notIn: unitSourceIds(unit, day) } } : {}),
    },
    _count: { _all: true },
  });
  const sum = (pool: RunPool) =>
    groups.reduce((total, group) => (group.pool === pool ? total + group._count._all : total), 0);

  const older = groups.filter(
    (group): group is typeof group & { workspaceId: string } => group.pool === null && typeof group.workspaceId === "string",
  );
  let olderMain = 0;
  if (older.length > 0) {
    const workspaces = await prisma.workspace.findMany({
      where: { id: { in: older.map((group) => group.workspaceId) } },
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
    olderMain = older.reduce(
      (total, group) =>
        capped.has(group.workspaceId) || !found.has(group.workspaceId) ? total + group._count._all : total,
      0,
    );
  }
  return { main: sum(RUN_POOL.main) + olderMain, newAccounts: sum(RUN_POOL.newAccounts) };
}

/**
 * R7-security M1: the one rule for the pools, shared by Post now (the
 * routes), the scanner and a retry: whether `size` runs (both halves of a
 * pair: 2) on the UTC day of `day` would go past this workspace's pool, and
 * which. The new-account pool is its own. The main pool never refuses runs
 * that fit inside the first GUARANTEED_RUNS_PER_PERSON of the day of any of
 * the workspace's confirmed, day-old owners. `unit` are the posts' ids when
 * known; their own runs that day are not counted against them, so a half
 * reserved by its pair adds nothing. A day still ahead has no runs.
 */
async function poolRefusal(input: {
  who: RunAttribution;
  day: Date;
  unit: readonly string[];
  size: number;
  now: Date;
}): Promise<"main" | "new" | null> {
  const { who, day, unit, size, now } = input;
  // `size` 0 with no unit: the runs were recorded first and are in the counts.
  if (who.pool === RUN_POOL.none) return null;
  const used = await poolRunsOnDay(day, unit, now);
  if (who.pool === RUN_POOL.newAccounts) {
    return used.newAccounts + size > NEW_ACCOUNT_POOL_DAILY_LIMIT ? "new" : null;
  }
  if (used.main + size <= SERVICE_DAILY_POST_LIMIT) return null;
  for (const owner of who.owners) {
    if (!established(owner, now)) continue;
    const freeIds = await ownerFreeWorkspaceIds(owner.userId);
    if ((await ownerRunsOnDay(owner.userId, day, unit, freeIds)) + size <= GUARANTEED_RUNS_PER_PERSON) return null;
  }
  return "main";
}

type CrossWorkspaceCheck = {
  workspace: BillingFields;
  day: Date;
  mode: CrossWorkspaceLimitMode;
  excludePostJobId?: string | readonly string[];
  alsoOnDay?: number;
  /** Second look, point 1: who will read the answer, so the owner held back reads "you". */
  viewerUserId?: string;
};

/**
 * The daily limits across workspaces, for a post committed to the UTC day of
 * `day` in `workspaceId` (whose billing columns are `workspace`), or for a
 * retry today: each owner's own number (personalPostLimitApplies; the lower
 * one for a new or unconfirmed account), then the workspace's pool. A
 * workspace any operator owns is never refused here. Throws on a database
 * error; checkDailyPostLimit fails open around it.
 */
export async function crossWorkspacePostRefusal(
  input: CrossWorkspaceCheck & { workspaceId: string },
): Promise<LimitRefusal | null> {
  const now = new Date();
  return refusalFor(await runAttribution(input.workspaceId, now), input, now);
}

async function refusalFor(who: RunAttribution, input: CrossWorkspaceCheck, now: Date): Promise<LimitRefusal | null> {
  const { day, mode } = input;
  if (who.operator) return null;
  const unit = unitIds(input.excludePostJobId);
  const size = 1 + (input.alsoOnDay ?? 0);

  if (personalPostLimitApplies(input.workspace)) {
    for (const owner of who.owners) {
      // R7 review, point 5: the lower number holds the account's first UTC
      // day, and every day until its email is confirmed.
      const { limit, reduced } = ownerDailyPostLimit(owner.user, day);
      if ((await ownerCountOnDay(owner.userId, day, unit)) + size > limit) {
        // Point 6: a co-owner whose lower number holds the workspace is named,
        // unless they are the one reading it.
        const holder = {
          name: owner.user.name?.trim() || owner.user.email,
          coOwned: who.owners.length > 1,
          isViewer: input.viewerUserId === owner.userId,
        };
        return { error: ownerDailyPostLimitMessage(limit, mode, reduced, holder), code: OWNER_DAILY_POST_LIMIT_CODE };
      }
    }
  }

  // A post given a later slot meets the pools when it is sent (the scanner);
  // now it meets only what has gone out on its day already.
  const sending = mode === "schedule" ? 1 : size;
  const pool = await poolRefusal({ who, day, unit, size: sending, now });
  if (pool === "new") return { error: newAccountPoolMessage(mode), code: SERVICE_DAILY_POST_LIMIT_CODE };
  if (pool === "main") return { error: serviceDailyPostLimitMessage(mode), code: SERVICE_DAILY_POST_LIMIT_CODE };
  return null;
}

/**
 * R6-security M2: the scanner's check as a scheduled post falls due, before
 * its results are made: the post, or both halves of a Feed and Story pair as
 * one unit (sent together or not at all). Only the pools: the per-workspace
 * and per-person limits counted the post when it was given its day, and they
 * only ever hold back their own workspaces. What the results then say, or
 * null to send. Fails open, like every usage check.
 */
export async function serviceCapRefusalAtSend(input: {
  workspaceId: string;
  postJobIds: readonly string[];
  now: Date;
  /**
   * R7 review, point 7: the posts' runs were recorded first (create, then
   * check), so they are counted as they stand and add nothing more.
   */
  recorded?: boolean;
}): Promise<{ errorCode: string; errorMessage: string } | null> {
  try {
    const who = await runAttribution(input.workspaceId, input.now);
    if (who.operator) return null;
    const pool = await poolRefusal({
      who,
      day: input.now,
      unit: input.recorded ? [] : input.postJobIds,
      size: input.recorded ? 0 : input.postJobIds.length,
      now: input.now,
    });
    if (pool === "new") return { errorCode: SERVICE_DAILY_POST_LIMIT_CODE, errorMessage: newAccountPoolAtSendMessage() };
    if (pool === "main") {
      return { errorCode: SERVICE_DAILY_POST_LIMIT_CODE, errorMessage: serviceDailyPostLimitAtSendMessage() };
    }
    return null;
  } catch (error) {
    logger.error("[usage] Service cap check at send failed; sending", { error, workspaceId: input.workspaceId });
    return null;
  }
}

type RetryCountClient = { usageEvent: Pick<Prisma.TransactionClient["usageEvent"], "count" | "findMany"> };

/** Older per-platform retry rows (before R7-security L1) of a post today, once per request. */
async function olderRetryRequestsToday(
  workspaceId: string,
  postJobId: string,
  now: Date,
  db: RetryCountClient = prisma,
): Promise<number> {
  const { start, end } = utcDayRange(now);
  const older = await db.usageEvent.findMany({
    where: {
      kind: USAGE_KIND.retry,
      workspaceId,
      sourceId: { startsWith: `${USAGE_KIND.retry}:${postJobId}:` },
      at: { gte: start, lt: end },
    },
    select: { sourceId: true },
  });
  return new Set(older.map((row) => row.sourceId?.split(":").pop()).filter(Boolean)).size;
}

/** The retry runs of a post on the UTC day of `now`, older per-platform rows once per request. */
async function retryRunsToday(
  workspaceId: string,
  postJobId: string,
  now: Date,
  db: RetryCountClient = prisma,
): Promise<number> {
  const { start, end } = utcDayRange(now);
  const runs = await db.usageEvent.count({
    where: { kind: USAGE_KIND.send, sourceId: { startsWith: retryRunPrefix(postJobId) }, at: { gte: start, lt: end } },
  });
  return runs + (await olderRetryRequestsToday(workspaceId, postJobId, now, db));
}

/**
 * R7-security L1: why this retry may not run, or null. A retry request is one
 * run, however many platforms it includes (Retry all failed is one). Each post
 * may have RETRIES_PER_POST_PER_DAY a UTC day, in every workspace but the
 * operator's: it only stops a post that keeps failing, so it applies to
 * paying ones too. Then the run counts toward the owners' per-person numbers
 * and the pool like a post, which paying workspaces are never refused by.
 * Fails open, like the post checks.
 */
export async function retryRefusal(input: {
  workspaceId: string;
  postJobId: string;
  now: Date;
  viewerUserId?: string;
}): Promise<LimitRefusal | null> {
  const { workspaceId, postJobId, now } = input;
  try {
    const who = await runAttribution(workspaceId, now);
    if (who.operator) return null;
    if ((await retryRunsToday(workspaceId, postJobId, now)) >= RETRIES_PER_POST_PER_DAY) {
      return { error: postRetryLimitMessage(RETRIES_PER_POST_PER_DAY), code: POST_RETRY_LIMIT_CODE };
    }
    return await refusalFor(
      who,
      { workspace: await ownBillingFields(workspaceId), day: now, mode: "retry", viewerUserId: input.viewerUserId },
      now,
    );
  } catch (error) {
    logger.error("[usage] Retry limit check failed; allowing", { error, workspaceId, postJobId });
    return null;
  }
}

/** How long a retry request may wait for the post's lock, and hold it. */
const RETRY_LOCK_TIMEOUT_MS = 10_000;

/**
 * The retry route's check and record, one post at a time (third look of the
 * R7 review). First the whole check (the 3-a-day guard, the per-person number
 * and the pools). Then, inside one transaction that first takes the post's
 * transaction lock (pg_advisory_xact_lock on its id), the post's retry runs
 * are counted again on that transaction and, when one is still allowed, the
 * run is recorded. A second click on the same post waits for the first's
 * transaction to end, so it sees the true count: with 2 used it gets the 3rd
 * only if the first did not record one, else the 3-times sentence, now true.
 * Everything inside the lock reads through the transaction's own connection.
 * Null: the run is recorded, and the caller takes it back with withdrawRetry
 * if its hand-over then fails. When the lock cannot be had, it records
 * without it (fails open, like every usage check).
 */
export async function reserveRetry(input: {
  workspaceId: string;
  postJobId: string;
  requestId: string;
  now: Date;
  viewerUserId?: string;
}): Promise<LimitRefusal | null> {
  const { workspaceId, postJobId, now } = input;
  const refusal = await retryRefusal({ workspaceId, postJobId, now, viewerUserId: input.viewerUserId });
  if (refusal) return refusal;
  // The operator is never refused, so only others are counted again below.
  let operator = false;
  try {
    operator = (await workspaceOwners(workspaceId)).some((owner) => isOperatorUser(owner.user));
  } catch (error) {
    logger.error("[usage] Couldn't read the retry's owners (allowing)", { error, workspaceId });
  }
  const record = { workspaceId, postJobId, requestId: input.requestId, at: now };
  const limited = { error: postRetryLimitMessage(RETRIES_PER_POST_PER_DAY), code: POST_RETRY_LIMIT_CODE };
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${postJobId}))`;
        // Only the guard can have changed while this request waited.
        if (!operator && (await retryRunsToday(workspaceId, postJobId, now, tx)) >= RETRIES_PER_POST_PER_DAY) {
          return limited;
        }
        await recordRetry(record, tx);
        return null;
      },
      { maxWait: RETRY_LOCK_TIMEOUT_MS, timeout: RETRY_LOCK_TIMEOUT_MS },
    );
  } catch (error) {
    logger.error("[usage] Retry lock failed; recording without it", { error, postJobId });
    await recordRetry(record);
    return null;
  }
}

type RetryRecordClient = { usageEvent: Pick<Prisma.TransactionClient["usageEvent"], "createMany"> };

/**
 * R7-security L1: records one retry request as one run, before it is handed
 * to the background, so the next request's check sees it (`db`: the
 * reserving transaction). withdrawRetry takes it back when that hand-over
 * fails. Never throws.
 */
export async function recordRetry(
  input: {
    workspaceId: string;
    postJobId: string;
    requestId: string;
    at: Date;
  },
  db: RetryRecordClient = prisma,
): Promise<void> {
  try {
    await db.usageEvent.createMany({
      data: await runRows(input.workspaceId, [retrySourceId(input.postJobId, input.requestId)], input.at),
      skipDuplicates: true,
    });
  } catch (error) {
    logger.error("[usage] Couldn't record a retry (ignored)", { error, workspaceId: input.workspaceId });
  }
}

/** Takes back the run of a retry request whose hand-over failed, and only that one. Never throws. */
export async function withdrawRetry(input: { postJobId: string; requestId: string }): Promise<void> {
  try {
    await prisma.usageEvent.deleteMany({
      where: { kind: USAGE_KIND.send, sourceId: retrySourceId(input.postJobId, input.requestId) },
    });
  } catch (error) {
    logger.error("[usage] Couldn't take back a retry (ignored)", { error });
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
