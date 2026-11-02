import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 2026-11-01 scale audit (W6): auto-caption caps its prompt fields, spends a
// per-workspace daily quota, bounds the provider call and asks reasoning models
// for low effort. `fetch` is stubbed - no provider is ever contacted - and
// `@/lib/workspace` / `@/lib/rateLimit` are mocked so Prisma never loads.
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
  role: "owner" as const,
};

const BLOB_URL = "https://abc123.public.blob.vercel-storage.com/photo.jpg";
const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function providerOk(content = "Fresh bread, warm smiles.") {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://localhost/api/posts/auto-caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const validBody = { blobUrl: BLOB_URL, mimeType: "image/jpeg" };

/** The JSON body of the (single) provider request. */
function sentBody(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
}

function sentPrompt(): string {
  return JSON.stringify((sentBody().messages as unknown[]) ?? []);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("XAI_API_KEY", "xai-key");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("XAI_TEXT_MODEL", "");
  vi.stubEnv("XAI_VISION_MODEL", "");
  vi.stubEnv("OPENAI_TEXT_MODEL", "");
  vi.stubEnv("OPENAI_VISION_MODEL", "");
  // Hermetic: the allowed-host check pins to the own blob store when known.
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
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

describe("POST /api/posts/auto-caption", () => {
  it("returns 401 without a workspace context", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await post(validBody);

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("generates a caption on the happy path", async () => {
    const response = await post(validBody);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ caption: "Fresh bread, warm smiles." });
  });

  describe("prompt field caps", () => {
    it.each(["platform", "language", "tone"])(
      "rejects an over-long %s with 400 AI_INPUT_TOO_LONG and never calls the provider",
      async (field) => {
        const response = await post({ ...validBody, [field]: "x".repeat(41) });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          code: "AI_INPUT_TOO_LONG",
          error: `${field} is too long (max 40 characters).`,
        });
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it("rejects before any rate-limit counter is spent (length check precedes the limits)", async () => {
      await post({ ...validBody, tone: "x".repeat(41) });

      expect(checkRateLimitMock).not.toHaveBeenCalled();
    });

    it("rejects an over-long blobUrl and mimeType, which are forwarded to the provider / logged", async () => {
      const longUrl = `${BLOB_URL}?${"q".repeat(2200)}`;

      const urlResponse = await post({ ...validBody, blobUrl: longUrl });
      expect(urlResponse.status).toBe(400);
      await expect(urlResponse.json()).resolves.toEqual({
        code: "AI_INPUT_TOO_LONG",
        error: "blobUrl is too long (max 2200 characters).",
      });

      const mimeResponse = await post({ ...validBody, mimeType: `image/${"x".repeat(40)}` });
      expect(mimeResponse.status).toBe(400);
      await expect(mimeResponse.json()).resolves.toMatchObject({ code: "AI_INPUT_TOO_LONG" });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts fields of exactly 40 characters", async () => {
      const response = await post({ ...validBody, platform: "p".repeat(40) });

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not let a non-string tone/language/platform smuggle a huge prompt past the cap", async () => {
      const huge = "z".repeat(5000);

      const response = await post({
        ...validBody,
        tone: [huge],
        language: { huge },
        platform: [huge],
      });

      expect(response.status).toBe(200);
      expect(sentPrompt()).not.toContain("zzzzzzzzzz");
    });
  });

  describe("per-workspace daily quota", () => {
    it("returns 429 AI_WORKSPACE_DAILY_LIMIT when the workspace quota is spent, without calling the provider", async () => {
      checkRateLimitMock.mockImplementation(async (opts: { userId: string }) =>
        opts.userId.startsWith("ai:workspace:")
          ? { allowed: false, retryAfterSeconds: 3600 }
          : { allowed: true },
      );

      const response = await post(validBody);

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("3600");
      await expect(response.json()).resolves.toEqual({
        code: "AI_WORKSPACE_DAILY_LIMIT",
        error: "Your workspace has reached today's AI limit. Try again tomorrow.",
        retryAfterSeconds: 3600,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("counts against the caller's workspace and keeps the per-user key unchanged", async () => {
      await post(validBody);

      const calls = checkRateLimitMock.mock.calls.map(([opts]) => opts);
      expect(calls).toContainEqual(
        expect.objectContaining({ userId: "user-1", route: "posts/auto-caption", limit: 10 }),
      );
      expect(calls).toContainEqual(
        expect.objectContaining({ userId: "ai:workspace:ws-1", limit: 200 }),
      );
    });

    it("stays 429 'Too many requests' when the per-user limit trips first, and spends no workspace quota", async () => {
      checkRateLimitMock.mockImplementation(async (opts: { userId: string }) =>
        opts.userId === "user-1" ? { allowed: false, retryAfterSeconds: 30 } : { allowed: true },
      );

      const response = await post(validBody);

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({ error: "Too many requests, slow down." });
      expect(checkRateLimitMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not spend workspace quota on a request that fails validation", async () => {
      const response = await post({ blobUrl: BLOB_URL });

      expect(response.status).toBe(400);
      const keys = checkRateLimitMock.mock.calls.map(([opts]) => opts.userId);
      expect(keys).not.toContain("ai:workspace:ws-1");
    });
  });

  describe("provider call", () => {
    it("sends reasoning_effort: 'low' to xAI grok-4.5", async () => {
      await post(validBody);

      expect(sentBody()).toMatchObject({ model: "grok-4.5", reasoning_effort: "low" });
    });

    it("keys reasoning_effort off the model actually sent (a non-reasoning vision model gets none)", async () => {
      vi.stubEnv("XAI_VISION_MODEL", "grok-4.20-0309-non-reasoning");

      await post(validBody);

      const body = sentBody();
      expect(body.model).toBe("grok-4.20-0309-non-reasoning");
      expect(body).not.toHaveProperty("reasoning_effort");
    });

    it("uses the text model (and its reasoning effort) for video", async () => {
      vi.stubEnv("XAI_TEXT_MODEL", "grok-4.6");
      vi.stubEnv("XAI_VISION_MODEL", "grok-4.20-0309-non-reasoning");

      await post({ blobUrl: BLOB_URL, mimeType: "video/mp4" });

      expect(sentBody()).toMatchObject({ model: "grok-4.6", reasoning_effort: "low" });
    });

    it("never sends reasoning_effort to the OpenAI fallback provider", async () => {
      vi.stubEnv("XAI_API_KEY", "");
      vi.stubEnv("OPENAI_API_KEY", "openai-key");

      await post(validBody);

      const body = sentBody();
      expect(body.model).toBe("gpt-4o");
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/chat/completions");
    });

    it("never sends reasoning_effort to OpenAI even when a grok-looking model id is configured", async () => {
      vi.stubEnv("XAI_API_KEY", "");
      vi.stubEnv("OPENAI_API_KEY", "openai-key");
      vi.stubEnv("OPENAI_VISION_MODEL", "grok-4.5");

      await post(validBody);

      expect(sentBody()).not.toHaveProperty("reasoning_effort");
    });

    it("passes an abort signal to the provider fetch", async () => {
      await post(validBody);

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("answers 504 AI_TIMEOUT when the provider call times out", async () => {
      fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

      const response = await post(validBody);

      expect(response.status).toBe(504);
      await expect(response.json()).resolves.toEqual({
        error: "The AI service took too long. Try again.",
        code: "AI_TIMEOUT",
      });
    });

    it("answers 504 AI_TIMEOUT when the abort fires while reading the response body", async () => {
      const bodyTimeout = new Response(null, { status: 200 });
      vi.spyOn(bodyTimeout, "json").mockRejectedValue(
        new DOMException("The operation timed out.", "TimeoutError"),
      );
      fetchMock.mockResolvedValue(bodyTimeout);

      const response = await post(validBody);

      expect(response.status).toBe(504);
      await expect(response.json()).resolves.toMatchObject({ code: "AI_TIMEOUT" });
    });

    it("keeps other provider failures as 500s", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));

      const response = await post(validBody);

      expect(response.status).toBe(500);
    });
  });
});
