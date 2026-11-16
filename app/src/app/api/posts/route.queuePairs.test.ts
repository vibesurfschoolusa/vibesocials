import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PostJobDTO, PostsResponse } from "@/lib/postsDto";
import { makeWorkspaceContext } from "../__test-helpers__/workspaceContextMock";

// R4 lows, item 1: the Queue lists both live halves of a Feed and Story post
// on the same page, and paging never repeats or skips a post. The keyset paging
// is the point here, so instead of scripted answers prisma.postJob.findMany is
// a small in-memory table that applies each query's where, orderBy and take.
const { getWorkspaceContextMock, postJobFindManyMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  postJobFindManyMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
  getWorkspaceMemberCount: vi.fn(async () => 1),
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/inngest", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/server/jobs/posting", async () => {
  const actual = await vi.importActual<typeof import("@/server/jobs/posting")>("@/server/jobs/posting");
  return { ...actual, createPostJobOnly: vi.fn(), createPostJobForExistingMedia: vi.fn() };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findMany: postJobFindManyMock },
    postMetric: { findMany: vi.fn(async () => []) },
    postJobMedia: { groupBy: vi.fn(async () => []) },
  },
}));

import { GET } from "./route";

type Row = {
  id: string;
  workspaceId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  scheduledFor: Date | null;
  storyOfPostJobId: string | null;
  clientChangeRequestedAt: Date | null;
  [key: string]: unknown;
};

let table: Row[] = [];

function compare(a: unknown, b: unknown): number {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  return (left as number | string) < (right as number | string) ? -1 : 1;
}

function same(a: unknown, b: unknown): boolean {
  return compare(a, b) === 0;
}

function isOperatorObject(cond: unknown): cond is Record<string, unknown> {
  return typeof cond === "object" && cond !== null && !(cond instanceof Date) && !Array.isArray(cond);
}

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (!isOperatorObject(cond)) return same(value, cond);
  for (const [op, operand] of Object.entries(cond)) {
    const ok = (() => {
      switch (op) {
        case "in":
          return (operand as unknown[]).some((o) => same(value, o));
        case "notIn":
          return !(operand as unknown[]).some((o) => same(value, o));
        case "not":
          return isOperatorObject(operand) ? !fieldMatches(value, operand) : !same(value, operand);
        case "lt":
          return compare(value, operand) < 0;
        case "lte":
          return compare(value, operand) <= 0;
        case "gt":
          return compare(value, operand) > 0;
        case "gte":
          return compare(value, operand) >= 0;
        default:
          throw new Error(`The fake table does not know the operator ${op}`);
      }
    })();
    if (!ok) return false;
  }
  return true;
}

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === "OR") {
      if (!(cond as Record<string, unknown>[]).some((w) => matches(row, w))) return false;
    } else if (key === "AND") {
      if (!(cond as Record<string, unknown>[]).every((w) => matches(row, w))) return false;
    } else if (key === "NOT") {
      const list = Array.isArray(cond) ? cond : [cond];
      if ((list as Record<string, unknown>[]).some((w) => matches(row, w))) return false;
    } else if (!fieldMatches(row[key], cond)) {
      return false;
    }
  }
  return true;
}

function findMany(args: {
  where?: Record<string, unknown>;
  orderBy?: Record<string, "asc" | "desc">[];
  take?: number;
}): Row[] {
  const rows = table.filter((row) => matches(row, args.where));
  const order = args.orderBy ?? [];
  rows.sort((a, b) => {
    for (const key of order) {
      const [field, direction] = Object.entries(key)[0];
      const c = compare(a[field], b[field]);
      if (c !== 0) return direction === "asc" ? c : -c;
    }
    return 0;
  });
  return args.take === undefined ? rows : rows.slice(0, args.take);
}

const BASE = Date.UTC(2026, 10, 1, 12, 0, 0);

/** A post of the workspace, `age` seconds older than the newest. */
function post(id: string, age: number, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: "ws-1",
    status: "scheduled",
    createdAt: new Date(BASE - age * 1000),
    updatedAt: new Date(BASE),
    scheduledFor: new Date(BASE + 86_400_000),
    storyOfPostJobId: null,
    clientChangeRequestedAt: null,
    baseCaption: id,
    perPlatformOverrides: null,
    submittedForApprovalAt: null,
    approvedAt: null,
    clientApprovedAt: null,
    clientNote: null,
    seriesId: null,
    coverTimeMs: null,
    coverImageUrl: null,
    mediaItemId: null,
    mediaItem: null,
    publishMetadata: { targetPlatforms: ["instagram"] },
    user: null,
    results: [],
    ...extra,
  };
}

/** A Story job of `feedId`: its publishMetadata names the Story placement. */
function story(id: string, feedId: string, age: number, extra: Partial<Row> = {}): Row {
  return post(id, age, {
    storyOfPostJobId: feedId,
    publishMetadata: { targetPlatforms: ["instagram"], instagram: { placement: "story" } },
    ...extra,
  });
}

/** `count` plain posts, ids `${prefix}-000`… , ages `from`, `from + 1`, … */
function plain(prefix: string, count: number, from: number): Row[] {
  return Array.from({ length: count }, (_, i) => post(`${prefix}-${String(i).padStart(3, "0")}`, from + i));
}

const QUEUE = "http://localhost/api/posts?status=scheduled,draft";

async function page(url: string): Promise<PostsResponse> {
  const address = new URL(url);
  address.searchParams.set("workspaceId", "ws-1");
  const response = await GET(new Request(address));
  expect(response.status).toBe(200);
  return (await response.json()) as PostsResponse;
}

/** Every page the Queue would load, first with clientChangesFirst as it does. */
async function allPages(base = QUEUE, first = `${QUEUE}&clientChangesFirst=1`): Promise<PostsResponse[]> {
  const pages = [await page(first)];
  for (let guard = 0; pages[pages.length - 1].nextCursor && guard < 50; guard++) {
    pages.push(await page(`${base}&cursor=${encodeURIComponent(pages[pages.length - 1].nextCursor!)}`));
  }
  return pages;
}

const ids = (jobs: readonly PostJobDTO[]) => jobs.map((job) => job.id);

/** The posts the Queue lists: draft or scheduled, this workspace. */
function liveIds(): string[] {
  return table
    .filter((row) => row.workspaceId === "ws-1" && (row.status === "draft" || row.status === "scheduled"))
    .map((row) => row.id)
    .sort();
}

/** Each page holds the live partner of every live half on it. */
function expectPairsTogether(pages: readonly PostsResponse[]) {
  for (const [index, p] of pages.entries()) {
    const onPage = new Set(ids(p.jobs));
    for (const job of p.jobs) {
      if (job.pairHalf) expect(onPage.has(job.pairHalf.id), `page ${index + 1}: ${job.id} without ${job.pairHalf.id}`).toBe(true);
    }
  }
}

/** Across all pages each listed post appears exactly once and none is missing. */
function expectEachOnce(pages: readonly PostsResponse[]) {
  const seen = pages.flatMap((p) => ids(p.jobs));
  expect(seen.length, "a post was listed twice").toBe(new Set(seen).size);
  expect([...seen].sort()).toEqual(liveIds());
}

beforeEach(() => {
  table = [];
  getWorkspaceContextMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  postJobFindManyMock.mockReset();
  postJobFindManyMock.mockImplementation(async (args) => findMany(args));
});

describe("GET /api/posts for the Queue - both halves of a Feed and Story post on one page", () => {
  it("a Story that ends page 1 brings its feed post, which page 2 does not repeat; nothing is skipped", async () => {
    // 49 newer posts, then the Story (50th), then its feed post (would be 51st), then 20 older.
    table = [
      ...plain("new", 49, 0),
      story("s-story", "s-feed", 100),
      post("s-feed", 101),
      ...plain("old", 20, 200),
    ];

    const pages = await allPages();

    expect(pages).toHaveLength(2);
    expect(ids(pages[0].jobs)).toContain("s-story");
    expect(ids(pages[0].jobs)).toContain("s-feed");
    expect(ids(pages[1].jobs)).not.toContain("s-feed");
    expect(pages[1].nextCursor).toBeNull();
    expectPairsTogether(pages);
    expectEachOnce(pages);
  });

  it("works the same when both halves were created in the same instant (one transaction)", async () => {
    table = [
      ...plain("new", 49, 0),
      // Same createdAt; the id decides which sorts first.
      story("z-story", "a-feed", 100),
      post("a-feed", 100),
      ...plain("old", 30, 200),
    ];

    const pages = await allPages();

    expectPairsTogether(pages);
    expectEachOnce(pages);
  });

  it("a feed post that ends page 1 brings its Story from far down the list", async () => {
    table = [...plain("new", 49, 0), post("f-feed", 100), ...plain("mid", 40, 200), story("f-story", "f-feed", 500), ...plain("old", 30, 600)];

    const pages = await allPages();

    expect(ids(pages[0].jobs)).toEqual(expect.arrayContaining(["f-feed", "f-story"]));
    expect(pages.slice(1).flatMap((p) => ids(p.jobs))).not.toContain("f-story");
    expectPairsTogether(pages);
    expectEachOnce(pages);
  });

  it("when the only post left after a page is that page's partner, there is no empty page to load", async () => {
    table = [...plain("new", 49, 0), story("e-story", "e-feed", 100), post("e-feed", 101)];

    const pages = await allPages();

    expect(pages).toHaveLength(1);
    expect(pages[0].nextCursor).toBeNull();
    expectEachOnce(pages);
  });

  it("a partner that is published, publishing, failed or cancelled is not added, and the half has no pairHalf", async () => {
    for (const status of ["completed", "in_progress", "failed", "cancelled"]) {
      table = [...plain("new", 49, 0), story("x-story", "x-feed", 100), post("x-feed", 101, { status }), ...plain("old", 5, 200)];

      const pages = await allPages();

      const lone = pages.flatMap((p) => p.jobs).find((job) => job.id === "x-story");
      expect(lone, status).toBeDefined();
      expect(lone, status).not.toHaveProperty("pairHalf");
      expect(pages.flatMap((p) => ids(p.jobs)), status).not.toContain("x-feed");
      expectEachOnce(pages);
    }
  });

  it("a partner in another workspace is never added", async () => {
    table = [...plain("new", 49, 0), story("w-story", "w-feed", 100), post("w-feed", 101, { workspaceId: "ws-2" }), ...plain("old", 5, 200)];

    const pages = await allPages();

    expect(pages.flatMap((p) => ids(p.jobs))).not.toContain("w-feed");
    expectEachOnce(pages);
  });

  it("many pairs split at every distance over several pages: each post once, every page whole", async () => {
    // A fixed pseudo-random layout: 200 plain posts and 40 pairs whose halves
    // are 0 to 120 places apart (0: created in the same instant), either half
    // the newer, some partners already gone out, some drafts.
    for (const seedStart of [7, 11, 23]) {
      let seed = seedStart;
      const next = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      const placed: { position: number; row: Row }[] = [];
      for (let j = 0; j < 200; j++) placed.push({ position: j, row: post(`p-${String(j).padStart(3, "0")}`, 0) });
      for (let k = 0; k < 40; k++) {
        const at = Math.floor(next() * 200) + 0.5 + k * 0.001;
        const gap = next() < 0.2 ? 0 : 1 + Math.floor(next() * 120);
        const feedId = `pair-${String(k).padStart(2, "0")}-feed`;
        const status = next() < 0.3 ? "draft" : "scheduled";
        const feed = post(feedId, 0, { status });
        const half = story(`pair-${String(k).padStart(2, "0")}-story`, feedId, 0, {
          status: next() < 0.15 ? "completed" : status,
        });
        const [newer, older] = next() < 0.5 ? [half, feed] : [feed, half];
        placed.push({ position: at, row: newer }, { position: at + gap, row: older });
      }
      table = placed.map(({ position, row }) => ({ ...row, createdAt: new Date(BASE - Math.round(position * 1000)) }));

      const pages = await allPages();

      expect(pages.length, `seed ${seedStart}`).toBeGreaterThan(3);
      expectPairsTogether(pages);
      expectEachOnce(pages);
    }
  });

  it("a client's change request on a feed post that sits beyond page 1 brings its Story to page 1 too", async () => {
    table = [
      ...plain("new", 60, 0),
      post("c-feed", 100, { status: "draft", clientChangeRequestedAt: new Date(BASE) }),
      story("c-story", "c-feed", 101, { status: "draft" }),
    ];

    const first = await page(`${QUEUE}&clientChangesFirst=1`);

    expect(ids(first.jobs)).toEqual(expect.arrayContaining(["c-feed", "c-story"]));
    expectPairsTogether([first]);
  });
});

describe("GET /api/posts for Activity - unchanged", () => {
  it("pages in plain (createdAt, id) order and adds no partner", async () => {
    table = [...plain("new", 49, 0), story("a-story", "a-feed", 100), post("a-feed", 101), ...plain("old", 10, 200)];

    const first = await page("http://localhost/api/posts");

    expect(first.jobs).toHaveLength(50);
    expect(ids(first.jobs)).not.toContain("a-feed");
    const second = await page(`http://localhost/api/posts?cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(ids(second.jobs)[0]).toBe("a-feed");
    expect(second.jobs).toHaveLength(11);
    expect(second.nextCursor).toBeNull();
  });

  it("asks for one page of posts and nothing more about partners", async () => {
    table = [...plain("new", 49, 0), story("a-story", "a-feed", 100), post("a-feed", 101)];

    await page("http://localhost/api/posts");

    // The page, then the pair-label lookup.
    expect(postJobFindManyMock).toHaveBeenCalledTimes(2);
  });

  it("a status filter other than the Queue's adds no partner", async () => {
    table = [...plain("new", 49, 0), story("a-story", "a-feed", 100), post("a-feed", 101)];

    const first = await page("http://localhost/api/posts?status=scheduled");

    expect(first.jobs).toHaveLength(50);
    expect(ids(first.jobs)).not.toContain("a-feed");
  });
});
