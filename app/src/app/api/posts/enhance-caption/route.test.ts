import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 2026-11-01 scale audit (W6): enhance-caption caps `caption`, spends the
// per-workspace daily quota (so it now resolves a workspace context instead of
// a bare user), bounds the provider call and asks reasoning models for low
// effort. `fetch` is stubbed - no provider is ever contacted.
const { getWorkspaceContextMock, checkRateLimitMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));

import { POST } from "./route";

const CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "member" as const,
};

const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function providerOk(content = "Fresh bread, warm smiles.") {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://localhost/api/posts/enhance-caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function sentBody(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("XAI_API_KEY", "xai-key");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("XAI_TEXT_MODEL", "");
  vi.stubEnv("OPENAI_TEXT_MODEL", "");
  getWorkspaceContextMock.mockResolvedValue(CONTEXT);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  fetchMock = vi.fn().mockImplementation(async () => providerOk());
  global.fetch = fetchMock as unknown as typeof fetch;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/posts/enhance-caption", () => {
  it("returns the existing 401 when there is no workspace context", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await post({ caption: "fresh bread" });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enhances a caption on the happy path (any member may call it)", async () => {
    const response = await post({ caption: "fresh bread" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enhancedCaption: "Fresh bread, warm smiles.",
    });
  });

  it("still requires a caption", async () => {
    const response = await post({ caption: "   " });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Caption is required" });
  });

  describe("caption cap", () => {
    it("accepts exactly 2200 characters", async () => {
      const response = await post({ caption: "c".repeat(2200) });

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects 2201 characters with 400 AI_INPUT_TOO_LONG and never calls the provider", async () => {
      const response = await post({ caption: "c".repeat(2201) });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "AI_INPUT_TOO_LONG",
        error: "caption is too long (max 2200 characters).",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects before any rate-limit counter is spent (length check precedes the limits)", async () => {
      await post({ caption: "c".repeat(2201) });

      expect(checkRateLimitMock).not.toHaveBeenCalled();
    });
  });

  describe("per-workspace daily quota", () => {
    it("returns 429 AI_WORKSPACE_DAILY_LIMIT when the workspace quota is spent, without calling the provider", async () => {
      checkRateLimitMock.mockImplementation(async (opts: { userId: string }) =>
        opts.userId.startsWith("ai:workspace:")
          ? { allowed: false, retryAfterSeconds: 7200 }
          : { allowed: true },
      );

      const response = await post({ caption: "fresh bread" });

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("7200");
      await expect(response.json()).resolves.toEqual({
        code: "AI_WORKSPACE_DAILY_LIMIT",
        error: "Your workspace has reached today's AI limit. Try again tomorrow.",
        retryAfterSeconds: 7200,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("counts against the caller's workspace and keeps the per-user key (the context user's id) unchanged", async () => {
      await post({ caption: "fresh bread" });

      const calls = checkRateLimitMock.mock.calls.map(([opts]) => opts);
      expect(calls).toContainEqual(
        expect.objectContaining({ userId: "user-1", route: "posts/enhance-caption", limit: 20 }),
      );
      expect(calls).toContainEqual(
        expect.objectContaining({ userId: "ai:workspace:ws-1", limit: 200 }),
      );
    });

    it("does not spend workspace quota on a request that fails validation", async () => {
      await post({ caption: "" });

      const keys = checkRateLimitMock.mock.calls.map(([opts]) => opts.userId);
      expect(keys).not.toContain("ai:workspace:ws-1");
    });
  });

  describe("provider call", () => {
    it("sends reasoning_effort: 'low' to xAI grok-4.5", async () => {
      await post({ caption: "fresh bread" });

      expect(sentBody()).toMatchObject({ model: "grok-4.5", reasoning_effort: "low" });
    });

    it("sends nothing extra for an xAI model that is not a reasoning model", async () => {
      vi.stubEnv("XAI_TEXT_MODEL", "grok-4.20-0309-non-reasoning");

      await post({ caption: "fresh bread" });

      expect(sentBody()).not.toHaveProperty("reasoning_effort");
    });

    it("never sends reasoning_effort to the OpenAI fallback provider", async () => {
      vi.stubEnv("XAI_API_KEY", "");
      vi.stubEnv("OPENAI_API_KEY", "openai-key");

      await post({ caption: "fresh bread" });

      const body = sentBody();
      expect(body.model).toBe("gpt-4o-mini");
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/chat/completions");
    });

    it("passes an abort signal to the provider fetch", async () => {
      await post({ caption: "fresh bread" });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("answers 504 AI_TIMEOUT when the provider call times out", async () => {
      fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

      const response = await post({ caption: "fresh bread" });

      expect(response.status).toBe(504);
      await expect(response.json()).resolves.toEqual({
        error: "The AI service took too long. Try again.",
        code: "AI_TIMEOUT",
      });
    });
  });
});
