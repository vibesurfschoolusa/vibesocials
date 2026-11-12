import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  requireOwnerContext: vi.fn(),
  checkRateLimit: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  queryRaw: vi.fn(),
  workspaceUpdate: vi.fn(),
  txQueueCreate: vi.fn(),
  queueCreate: vi.fn(),
  mediaAny: vi.fn(),
  transaction: vi.fn(),
  log: [] as string[],
  inTx: false,
}));

// Every MediaItem method the logo could touch: none of them may be called, so
// the logo never shows in the Media library, in storage usage (which sums
// MediaItem rows) or in the retention sweep (which selects MediaItem rows).
const { mediaItem, tx } = vi.hoisted(() => {
  const mediaItem = new Proxy(
    {},
    { get: (_target, method) => (...args: unknown[]) => m.mediaAny(method, ...args) },
  );
  const tx = {
    $queryRaw: (...args: unknown[]) => m.queryRaw(...args),
    workspace: { update: (...args: unknown[]) => m.workspaceUpdate(...args) },
    pendingBlobDeletion: { create: (...args: unknown[]) => m.txQueueCreate(...args) },
    mediaItem,
  };
  return { mediaItem, tx };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => m.transaction(...args),
    pendingBlobDeletion: { create: (...args: unknown[]) => m.queueCreate(...args) },
    mediaItem,
    $queryRaw: (...args: unknown[]) => m.mediaAny("$queryRaw", ...args),
  },
}));
vi.mock("@/lib/workspace", () => ({ requireOwnerContext: m.requireOwnerContext }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: m.checkRateLimit }));
vi.mock("@vercel/blob", () => ({ put: m.put, del: m.del }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { NextResponse } from "next/server";

import {
  LOGO_CHANGES_PER_HOUR,
  LOGO_MAX_BYTES,
  LOGO_NOT_IMAGE_MESSAGE,
  LOGO_SAVE_FAILED_MESSAGE,
  LOGO_SVG_MESSAGE,
  LOGO_TOO_LARGE_MESSAGE,
} from "@/lib/workspaceLogo";

import { WORKSPACE_CHANGED_CODE, WORKSPACE_CHANGED_MESSAGE } from "@/lib/workspaceChanged";

import { DELETE, POST } from "./route";

const OWNER = { user: { id: "user-1" }, workspace: { id: "ws-1", name: "Surf Co" }, role: "owner" as const };
const OLD = "https://abc.public.blob.vercel-storage.com/logos/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png";
const blobUrl = (pathname: string) => `https://abc.public.blob.vercel-storage.com/${pathname}`;
const forbidden = () => NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 });

const BASE = "http://localhost/api/workspaces/logo";
/** The workspace the Settings page was rendered for; null sends none. */
const address = (workspaceId: string | null) =>
  workspaceId === null ? BASE : `${BASE}?workspaceId=${encodeURIComponent(workspaceId)}`;

function upload(body: BodyInit | null, headers: Record<string, string> = {}, workspaceId: string | null = "ws-1"): Request {
  return new Request(address(workspaceId), {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);
}

const remove = (workspaceId: string | null = "ws-1") => new Request(address(workspaceId), { method: "DELETE" });

async function picture(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: "#0ea5e9" } }).jpeg().toBuffer();
}

/** The bytes handed to the file store by the last put(). */
const storedBytes = () => m.put.mock.calls.at(-1)?.[1] as Buffer;

beforeEach(() => {
  for (const fn of Object.values(m)) if (typeof fn === "function") fn.mockReset();
  m.log.length = 0;
  m.inTx = false;
  m.requireOwnerContext.mockResolvedValue(OWNER);
  m.checkRateLimit.mockResolvedValue({ allowed: true });
  m.put.mockImplementation(async (pathname: string) => {
    m.log.push(`put ${pathname}`);
    return { url: blobUrl(pathname), pathname };
  });
  m.del.mockImplementation(async (key: string) => {
    m.log.push(`del ${key}`);
  });
  m.transaction.mockImplementation(async (cb: (client: typeof tx) => unknown) => {
    m.log.push("begin");
    m.inTx = true;
    try {
      const result = await cb(tx);
      m.log.push("commit");
      return result;
    } finally {
      m.inTx = false;
    }
  });
  m.queryRaw.mockImplementation(async () => {
    m.log.push("lock workspace");
    return [{ logoUrl: OLD }];
  });
  m.workspaceUpdate.mockImplementation(async (args: { data: { logoUrl: string | null } }) => {
    m.log.push(`save ${args.data.logoUrl}`);
    return {};
  });
  m.txQueueCreate.mockImplementation(async (args: { data: { url: string } }) => {
    m.log.push(`queue in tx ${args.data.url} ${m.inTx}`);
    return {};
  });
  m.queueCreate.mockImplementation(async (args: { data: { url: string } }) => {
    m.log.push(`queue ${args.data.url}`);
    return {};
  });
});

describe("POST /api/workspaces/logo", () => {
  it("refuses a member, reading and storing nothing", async () => {
    m.requireOwnerContext.mockResolvedValue(forbidden());
    const response = await POST(upload(await picture(100, 100)));
    expect(response.status).toBe(403);
    expect(m.put).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("is rate limited to 10 an hour per owner, failing closed", async () => {
    m.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });
    const response = await POST(upload(await picture(100, 100)));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    expect(m.checkRateLimit).toHaveBeenCalledWith({
      userId: "user-1",
      route: "workspaces/logo",
      limit: LOGO_CHANGES_PER_HOUR,
      windowMs: 60 * 60 * 1000,
      failClosed: true,
    });
    expect(m.put).not.toHaveBeenCalled();
  });

  it("refuses more than 1 MB without reading it all", async () => {
    const state = { pulled: 0 };
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const response = await POST(upload(endless));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: LOGO_TOO_LARGE_MESSAGE });
    expect(state.pulled).toBeLessThanOrEqual(18);
    expect(m.put).not.toHaveBeenCalled();

    const declared = await POST(upload(new Uint8Array(10), { "content-length": String(LOGO_MAX_BYTES + 1) }));
    expect(declared.status).toBe(413);
  });

  it("refuses a non-image, an SVG and a truncated file in plain words", async () => {
    const text = await POST(upload("not a picture"));
    expect(text.status).toBe(400);
    expect(await text.json()).toEqual({ error: LOGO_NOT_IMAGE_MESSAGE });

    const svg = await POST(upload('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'));
    expect(svg.status).toBe(400);
    expect(await svg.json()).toEqual({ error: LOGO_SVG_MESSAGE });

    const whole = await picture(900, 900);
    const truncated = await POST(upload(whole.subarray(0, Math.floor(whole.length / 2))));
    expect(truncated.status).toBe(400);

    expect(m.put).not.toHaveBeenCalled();
  });

  it("stores the server's own PNG within 600 by 300, at logos/<32 random hex>.png, public", async () => {
    const input = await picture(1500, 500);
    const response = await POST(upload(input));

    expect(response.status).toBe(200);
    const [pathname, bytes, options] = m.put.mock.calls[0];
    // Nothing in the address names the workspace.
    expect(pathname).toMatch(/^logos\/[0-9a-f]{32}\.png$/);
    expect(options).toMatchObject({ access: "public", contentType: "image/png" });
    expect(bytes.equals(input)).toBe(false);
    const meta = await sharp(storedBytes()).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 600, 200]);
    expect(await response.json()).toEqual({ logoUrl: blobUrl(pathname) });
  });

  it("uploads first, then in one transaction queues the old logo and saves the new address", async () => {
    await POST(upload(await picture(100, 100)));
    const pathname = m.put.mock.calls[0][0];

    expect(m.log).toEqual([
      `put ${pathname}`,
      "begin",
      "lock workspace",
      `queue in tx ${OLD} true`,
      `save ${blobUrl(pathname)}`,
      "commit",
    ]);
    // The old file is left to the hourly drain: never deleted here.
    expect(m.del).not.toHaveBeenCalled();
    expect(m.workspaceUpdate).toHaveBeenCalledWith({ where: { id: "ws-1" }, data: { logoUrl: blobUrl(pathname) } });
  });

  it("queues nothing when there was no logo before", async () => {
    m.queryRaw.mockResolvedValue([{ logoUrl: null }]);
    await POST(upload(await picture(100, 100)));
    expect(m.txQueueCreate).not.toHaveBeenCalled();
    expect(m.workspaceUpdate).toHaveBeenCalled();
  });

  it("deletes the file it just uploaded when the database write fails", async () => {
    m.workspaceUpdate.mockRejectedValue(new Error("db down"));
    const response = await POST(upload(await picture(100, 100)));
    const url = blobUrl(m.put.mock.calls[0][0]);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: LOGO_SAVE_FAILED_MESSAGE });
    expect(m.del).toHaveBeenCalledWith(url, expect.anything());
    expect(m.queueCreate).not.toHaveBeenCalled();
  });

  it("queues the new file when the database write and the delete both fail", async () => {
    m.workspaceUpdate.mockRejectedValue(new Error("db down"));
    m.del.mockRejectedValue(new Error("blob down"));
    const response = await POST(upload(await picture(100, 100)));
    const url = blobUrl(m.put.mock.calls[0][0]);

    expect(response.status).toBe(500);
    expect(m.queueCreate).toHaveBeenCalledWith({ data: { url } });
  });

  it("answers 500 and writes nothing when the file store refuses the upload", async () => {
    m.put.mockRejectedValue(new Error("store down"));
    const response = await POST(upload(await picture(100, 100)));
    expect(response.status).toBe(500);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("never creates or reads a media item", async () => {
    await POST(upload(await picture(100, 100)));
    await DELETE(remove());
    expect(m.mediaAny).not.toHaveBeenCalled();
  });
});

// Fix round 1 (18b): the active workspace is a cookie every tab shares, so the
// control sends the workspace its page was rendered for.
describe("the workspace the page was rendered for", () => {
  it("lets an upload and a removal through when it matches, or when none is sent", async () => {
    expect((await POST(upload(await picture(50, 50)))).status).toBe(200);
    expect((await POST(upload(await picture(50, 50), {}, null))).status).toBe(200);
    expect((await DELETE(remove())).status).toBe(200);
    expect((await DELETE(remove(null))).status).toBe(200);
  });

  it("answers an upload for another workspace 409 before reading the body or storing anything", async () => {
    const state = { pulled: 0 };
    // highWaterMark 0: the stream reads nothing ahead by itself, so any pull is the route's.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          state.pulled += 1;
          controller.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    );

    const response = await POST(upload(body, {}, "ws-2"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: WORKSPACE_CHANGED_MESSAGE, code: WORKSPACE_CHANGED_CODE });
    expect(state.pulled).toBe(0);
    expect(m.checkRateLimit).not.toHaveBeenCalled();
    expect(m.put).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("answers a removal for another workspace 409 and changes nothing", async () => {
    const response = await DELETE(remove("ws-2"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: WORKSPACE_CHANGED_MESSAGE, code: WORKSPACE_CHANGED_CODE });
    expect(m.transaction).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/workspaces/logo", () => {
  it("refuses a member", async () => {
    m.requireOwnerContext.mockResolvedValue(forbidden());
    expect((await DELETE(remove())).status).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("queues the old logo and clears the address in one transaction, deleting nothing itself", async () => {
    const response = await DELETE(remove());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ logoUrl: null });
    expect(m.log).toEqual(["begin", "lock workspace", `queue in tx ${OLD} true`, "save null", "commit"]);
    expect(m.del).not.toHaveBeenCalled();
  });

  it("does nothing when there is no logo", async () => {
    m.queryRaw.mockResolvedValue([{ logoUrl: null }]);
    const response = await DELETE(remove());
    expect(response.status).toBe(200);
    expect(m.txQueueCreate).not.toHaveBeenCalled();
    expect(m.workspaceUpdate).not.toHaveBeenCalled();
  });

  it("is rate limited with the upload", async () => {
    m.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    expect((await DELETE(remove())).status).toBe(429);
    expect(m.transaction).not.toHaveBeenCalled();
  });
});

// P1: the report logo comes with the Growth and Pro plans.
describe("POST /api/workspaces/logo by plan", () => {
  const LATER = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
  const STARTER = { plan: "starter", planStatus: "active", currentPeriodEnd: LATER };
  const owner = (billing: Record<string, unknown>) => ({ ...OWNER, workspace: { ...OWNER.workspace, ...billing } });

  afterEach(() => vi.unstubAllEnvs());

  it("refuses an upload on Starter with the code and the sentence, before reading or storing anything", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    m.requireOwnerContext.mockResolvedValue(owner(STARTER));
    const response = await POST(upload(await picture(40, 20)));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "The report logo and the monthly report email are part of the Growth and Pro plans. See Settings, Plan.",
      code: "PLAN_FEATURE",
    });
    expect(m.put).not.toHaveBeenCalled();
    expect(m.checkRateLimit).not.toHaveBeenCalled();
  });

  it("still removes a saved logo on Starter", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    m.requireOwnerContext.mockResolvedValue(owner(STARTER));
    expect((await DELETE(remove())).status).toBe(200);
  });

  it("takes an upload on Growth, in a trial, for an exempt workspace and with billing off", async () => {
    for (const [billing, on] of [
      [{ ...STARTER, plan: "growth" }, true],
      [{ trialEndsAt: LATER }, true],
      [{ ...STARTER, billingExempt: true }, true],
      [STARTER, false],
    ] as const) {
      vi.stubEnv("BILLING_ENABLED", on ? "true" : "");
      m.requireOwnerContext.mockResolvedValue(owner(billing));
      expect((await POST(upload(await picture(40, 20)))).status).toBe(200);
    }
  });
});
