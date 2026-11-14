import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory PostJob table (the cover columns only) and the deletion queue.
const m = vi.hoisted(() => ({
  jobs: [] as { id: string; status: string; updatedAt: Date; coverImageUrl: string | null }[],
  queued: [] as string[],
  failQueue: false,
  // Runs after the sweep's read and before its UPDATE, to stage a race.
  afterRead: null as null | (() => void),
}));

vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/db", () => {
  type Where = {
    coverImageUrl?: string | { not: null };
    status?: { in: string[] };
    updatedAt?: { lt: Date };
  };
  const matches = (job: (typeof m.jobs)[number], where: Where) => {
    if (typeof where.coverImageUrl === "string" && job.coverImageUrl !== where.coverImageUrl) return false;
    if (where.coverImageUrl && typeof where.coverImageUrl === "object" && job.coverImageUrl === null) return false;
    if (where.status && !where.status.in.includes(job.status)) return false;
    if (where.updatedAt && !(job.updatedAt < where.updatedAt.lt)) return false;
    return true;
  };
  const db = {
    postJob: {
      findMany: vi.fn(async ({ where, take }: { where: Where; take?: number }) => {
        const rows = m.jobs.filter((job) => matches(job, where)).slice(0, take ?? Infinity).map((job) => ({ ...job }));
        m.afterRead?.();
        return rows;
      }),
      count: vi.fn(async ({ where }: { where: Where }) => m.jobs.filter((job) => matches(job, where)).length),
    },
    pendingBlobDeletion: {
      create: vi.fn(async ({ data }: { data: { url: string } }) => {
        if (m.failQueue) throw new Error("db down");
        m.queued.push(data.url);
        return { id: "q", url: data.url };
      }),
    },
    // UPDATE "PostJob" SET "coverImageUrl" = NULL WHERE id = $1 AND "coverImageUrl" = $2
    //   AND status IN ('completed','cancelled') AND "updatedAt" < $3
    // The conditions apply only when the SQL actually states them.
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, id: string, url: string, cutoff?: Date) => {
      const sql = strings.join("?");
      const checksStatus = sql.includes('"status"');
      const checksAge = sql.includes('"updatedAt" <');
      const job = m.jobs.find(
        (row) =>
          row.id === id &&
          row.coverImageUrl === url &&
          (!checksStatus || ["completed", "cancelled"].includes(row.status)) &&
          (!checksAge || (cutoff !== undefined && row.updatedAt < cutoff)),
      );
      if (!job) return 0;
      job.coverImageUrl = null;
      return 1;
    }),
  };
  return { prisma: { ...db, $transaction: async (fn: (tx: typeof db) => unknown) => fn(db) } };
});

import { COVER_SWEEP_BATCH_SIZE, queueCoverBlobIfUnused, sweepOldCovers } from "./coverBlobs";

const NOW = Date.parse("2026-12-30T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const cover = (name: string) => `https://abc.public.blob.vercel-storage.com/covers/ws-1/${name}.jpg`;

beforeEach(() => {
  m.jobs.length = 0;
  m.queued.length = 0;
  m.failQueue = false;
  m.afterRead = null;
});

describe("sweepOldCovers (media retention sweep)", () => {
  // Second review: a failed post can still be retried (its media may be in use
  // much later), so only completed and cancelled posts let go of their cover.
  it("deletes an old completed or cancelled post's cover and keeps a failed, scheduled, draft or recent one's", async () => {
    m.jobs.push(
      { id: "old-done", status: "completed", updatedAt: new Date(NOW - 40 * DAY), coverImageUrl: cover("a") },
      { id: "old-cancelled", status: "cancelled", updatedAt: new Date(NOW - 31 * DAY), coverImageUrl: cover("b") },
      { id: "old-failed", status: "failed", updatedAt: new Date(NOW - 90 * DAY), coverImageUrl: cover("f") },
      { id: "old-scheduled", status: "scheduled", updatedAt: new Date(NOW - 60 * DAY), coverImageUrl: cover("c") },
      { id: "old-draft", status: "draft", updatedAt: new Date(NOW - 60 * DAY), coverImageUrl: cover("d") },
      { id: "recent", status: "completed", updatedAt: new Date(NOW - 2 * DAY), coverImageUrl: cover("e") },
    );

    const result = await sweepOldCovers({ now: () => NOW });

    expect(m.queued.sort()).toEqual([cover("a"), cover("b")]);
    expect(result).toEqual({ cleared: 2, queued: 2 });
    expect(m.jobs.find((j) => j.id === "old-done")?.coverImageUrl).toBeNull();
    expect(m.jobs.find((j) => j.id === "old-scheduled")?.coverImageUrl).toBe(cover("c"));
    expect(m.jobs.find((j) => j.id === "old-failed")?.coverImageUrl).toBe(cover("f"));
    expect(m.jobs.find((j) => j.id === "recent")?.coverImageUrl).toBe(cover("e"));
  });

  it("keeps a cover a later post of the same series still uses", async () => {
    m.jobs.push(
      { id: "s1", status: "completed", updatedAt: new Date(NOW - 40 * DAY), coverImageUrl: cover("series") },
      { id: "s2", status: "scheduled", updatedAt: new Date(NOW - 40 * DAY), coverImageUrl: cover("series") },
    );

    await sweepOldCovers({ now: () => NOW });

    expect(m.jobs.find((j) => j.id === "s1")?.coverImageUrl).toBeNull();
    expect(m.queued).toEqual([]);
  });

  it("takes at most one batch per run", async () => {
    for (let i = 0; i < COVER_SWEEP_BATCH_SIZE + 5; i++) {
      m.jobs.push({ id: `j${i}`, status: "completed", updatedAt: new Date(NOW - 40 * DAY), coverImageUrl: cover(`x${i}`) });
    }
    const result = await sweepOldCovers({ now: () => NOW });
    expect(result.cleared).toBe(COVER_SWEEP_BATCH_SIZE);
  });

  it("never throws: a queue failure is logged and the run goes on", async () => {
    m.jobs.push({ id: "old", status: "completed", updatedAt: new Date(NOW - 40 * DAY), coverImageUrl: cover("a") });
    m.failQueue = true;
    await expect(sweepOldCovers({ now: () => NOW })).resolves.toMatchObject({ queued: 0 });
  });
});

describe("queueCoverBlobIfUnused (deleting a post)", () => {
  it("queues the file once no post uses it, and keeps it while one does", async () => {
    m.jobs.push({ id: "other", status: "scheduled", updatedAt: new Date(NOW), coverImageUrl: cover("shared") });

    await queueCoverBlobIfUnused(cover("shared"));
    await queueCoverBlobIfUnused(cover("mine"));

    expect(m.queued).toEqual([cover("mine")]);
  });

  it("never throws", async () => {
    m.failQueue = true;
    await expect(queueCoverBlobIfUnused(cover("mine"))).resolves.toBe(false);
  });
});

describe("sweepOldCovers - a post that changes after the read", () => {
  // Second review: Retry moved a post to in_progress between the sweep's read
  // and its UPDATE; the UPDATE re-checks status and age, so the cover stays.
  it("keeps the cover of a post retried or edited after the sweep read it", async () => {
    m.jobs.push(
      { id: "retried", status: "completed", updatedAt: new Date(NOW - 40 * DAY), coverImageUrl: cover("r") },
      { id: "touched", status: "completed", updatedAt: new Date(NOW - 40 * DAY), coverImageUrl: cover("t") },
    );
    m.afterRead = () => {
      const retried = m.jobs.find((j) => j.id === "retried")!;
      retried.status = "in_progress";
      const touched = m.jobs.find((j) => j.id === "touched")!;
      touched.updatedAt = new Date(NOW);
    };

    const result = await sweepOldCovers({ now: () => NOW });

    expect(result).toEqual({ cleared: 0, queued: 0 });
    expect(m.queued).toEqual([]);
    expect(m.jobs.map((j) => j.coverImageUrl)).toEqual([cover("r"), cover("t")]);
  });
});

