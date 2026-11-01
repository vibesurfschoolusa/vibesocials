import type { Platform } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCaptionWithFooter } from "@/lib/captionFooter";
import type { PublishContext } from "@/server/platforms/types";

// Handler-level tests for the publish pipeline's Inngest functions. vitest
// hoists vi.mock above the imports: every module inngest-functions.ts pulls in
// that touches `@/lib/db` receives this mock, and no platform API is called —
// getPlatformClient returns a stub client whose publishVideo records its ctx.
const db = vi.hoisted(() => ({
  postJobFindUnique: vi.fn(),
  postJobUpdate: vi.fn(),
  userFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  mediaItemFindUnique: vi.fn(),
  connectionFindMany: vi.fn(),
  connectionFindUnique: vi.fn(),
  resultFindMany: vi.fn(),
  resultUpdate: vi.fn(),
  resultUpdateMany: vi.fn(),
}));
const { getPlatformClientMock } = vi.hoisted(() => ({ getPlatformClientMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findUnique: db.postJobFindUnique, update: db.postJobUpdate },
    user: { findUnique: db.userFindUnique },
    workspace: { findUnique: db.workspaceFindUnique },
    mediaItem: { findUnique: db.mediaItemFindUnique },
    socialConnection: { findMany: db.connectionFindMany, findUnique: db.connectionFindUnique },
    postJobResult: {
      findMany: db.resultFindMany,
      update: db.resultUpdate,
      updateMany: db.resultUpdateMany,
    },
  },
}));
vi.mock("@/server/platforms", () => ({ getPlatformClient: getPlatformClientMock }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));

import { publishToAllPlatforms, retryPlatforms } from "./inngest-functions";

const WORKSPACE = { id: "ws-1", companyWebsite: null, defaultHashtags: "#brand" };

type HandlerArgs = { event: { name: string; data: Record<string, unknown> }; step: FakeStep };
type FakeStep = ReturnType<typeof fakeStep>;

/**
 * Minimal stand-in for Inngest's `step`: runs each step inline and
 * JSON-round-trips its output the way Inngest's memoization does (Dates come
 * back as strings), so a step that leaks a non-serializable value shows up here.
 */
function fakeStep() {
  return {
    run: vi.fn(async (_id: string, cb: () => unknown) => {
      const out = await cb();
      return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
    }),
    sendEvent: vi.fn(async () => ({ ids: [] as string[] })),
  };
}

/** The function's handler. `fn` is private in Inngest's types but plain at runtime. */
function handlerOf(fn: unknown): (args: HandlerArgs) => Promise<unknown> {
  return (fn as { fn: (args: HandlerArgs) => Promise<unknown> }).fn;
}

function connectionRow(platform: Platform) {
  return {
    id: `conn-${platform}`,
    platform,
    userId: "user-1",
    workspaceId: WORKSPACE.id,
    accessToken: "token",
    refreshToken: null,
    expiresAt: null,
    needsReconnect: false,
    metadata: null,
  };
}

let publishCtxs: PublishContext[];

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  getPlatformClientMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  publishCtxs = [];
  getPlatformClientMock.mockImplementation(() => ({
    publishVideo: vi.fn(async (ctx: PublishContext) => {
      publishCtxs.push(ctx);
      return { externalPostId: `ext-${ctx.socialConnection.platform}` };
    }),
  }));

  db.userFindUnique.mockResolvedValue({ id: "user-1" });
  db.workspaceFindUnique.mockResolvedValue(WORKSPACE);
  db.connectionFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(connectionRow(where.id.replace("conn-", "") as Platform)),
  );
  db.resultUpdate.mockResolvedValue({});
  db.resultUpdateMany.mockResolvedValue({ count: 0 });
  db.postJobUpdate.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Result rows: `select: { id, platform }` lookups get ids; status lookups get statuses. */
function stubResults(platforms: Platform[], status: "success" | "failed" = "success") {
  db.resultFindMany.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
    Promise.resolve(
      select.platform
        ? platforms.map((p) => ({ id: `result-${p}`, platform: p }))
        : platforms.map(() => ({ status })),
    ),
  );
}

function ctxFor(platform: Platform): PublishContext {
  const ctx = publishCtxs.find((c) => c.socialConnection.platform === platform);
  if (!ctx) throw new Error(`no publish for ${platform}`);
  return ctx;
}

describe("retryPlatforms — caption source (Task 4 item 1)", () => {
  const media = {
    id: "media-1",
    baseCaption: "Caption from the original upload",
    perPlatformOverrides: { x: "media-level X override" },
    deletedAt: null,
    mimeType: "video/mp4",
  };

  function retry(platforms: Platform[]) {
    return handlerOf(retryPlatforms)({
      event: {
        name: "post/retry.requested",
        data: { postJobId: "job-1", userId: "user-1", platforms },
      },
      step: fakeStep(),
    });
  }

  beforeEach(() => {
    db.mediaItemFindUnique.mockResolvedValue(media);
    db.connectionFindMany.mockResolvedValue([
      { id: "conn-x", platform: "x" },
      { id: "conn-youtube", platform: "youtube" },
    ]);
    stubResults(["x", "youtube"]);
  });

  it("re-publishes the JOB's own caption and overrides, not the shared media item's", async () => {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1",
      workspaceId: WORKSPACE.id,
      mediaItemId: "media-1",
      baseCaption: "Typed for this post",
      perPlatformOverrides: { x: "job-level X override" },
      publishMetadata: null,
    });

    await retry(["x", "youtube"]);

    expect(ctxFor("x").caption).toBe(buildCaptionWithFooter("job-level X override", WORKSPACE));
    expect(ctxFor("youtube").caption).toBe(buildCaptionWithFooter("Typed for this post", WORKSPACE));
    // YouTube's title source (no footer) is the job's caption too.
    expect(ctxFor("youtube").baseCaption).toBe("Typed for this post");
  });

  it("falls back to the media item for a legacy job with no snapshot", async () => {
    db.postJobFindUnique.mockResolvedValue({
      id: "job-1",
      workspaceId: WORKSPACE.id,
      mediaItemId: "media-1",
      baseCaption: null,
      perPlatformOverrides: null,
      publishMetadata: null,
    });

    await retry(["x", "youtube"]);

    expect(ctxFor("x").caption).toBe(buildCaptionWithFooter("media-level X override", WORKSPACE));
    expect(ctxFor("youtube").baseCaption).toBe("Caption from the original upload");
  });
});

describe("publishToAllPlatforms — YouTube title source (Task 4 item 1)", () => {
  it("hands the post's base caption (from the event) to the client for the title", async () => {
    db.postJobFindUnique.mockResolvedValue({ id: "job-1", workspaceId: WORKSPACE.id });
    db.mediaItemFindUnique.mockResolvedValue({
      id: "media-1",
      baseCaption: "Caption from the original upload",
      deletedAt: null,
    });
    db.connectionFindMany.mockResolvedValue([{ id: "conn-youtube", platform: "youtube" }]);
    stubResults(["youtube"]);

    await handlerOf(publishToAllPlatforms)({
      event: {
        name: "post/publish.requested",
        data: {
          postJobId: "job-1",
          userId: "user-1",
          mediaItemId: "media-1",
          baseCaption: "Typed for this post",
          perPlatformOverrides: null,
        },
      },
      step: fakeStep(),
    });

    expect(ctxFor("youtube").baseCaption).toBe("Typed for this post");
    expect(ctxFor("youtube").caption).toBe(buildCaptionWithFooter("Typed for this post", WORKSPACE));
  });
});
