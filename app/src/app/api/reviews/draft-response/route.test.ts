import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 2026-11-01 scale audit (W6): draft-response caps every prompt field, spends
// the per-workspace daily quota, bounds the provider call and asks reasoning
// models for low effort. `fetch` is stubbed - no provider is ever contacted.
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

function providerOk(content = "Thank you so much for the kind words!") {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://localhost/api/reviews/draft-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const validBody = {
  reviewerName: "Jane Doe",
  starRating: "FIVE",
  comment: "Great bread!",
  businessName: "Acme Bakery",
};

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

describe("POST /api/reviews/draft-response", () => {
  it("returns 401 without a workspace context", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await post(validBody);

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drafts a response on the happy path", async () => {
    const response = await post(validBody);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      draftResponse: "Thank you so much for the kind words!",
    });
  });

  it("still requires a reviewer name and star rating", async () => {
    const response = await post({ comment: "hi" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Reviewer name and star rating are required",
    });
  });

  describe("prompt field caps", () => {
    it.each([
      ["comment", 5000],
      ["reviewerName", 200],
      ["businessName", 200],
      ["starRating", 40],
    ])(
      "rejects an over-long %s (max %i) with 400 AI_INPUT_TOO_LONG and never calls the provider",
      async (field, max) => {
        const response = await post({ ...validBody, [field]: "x".repeat(max + 1) });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          code: "AI_INPUT_TOO_LONG",
          error: `${field} is too long (max ${max} characters).`,
        });
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it("accepts fields of exactly their maximum", async () => {
      const response = await post({
        reviewerName: "n".repeat(200),
        starRating: "FIVE",
        comment: "c".repeat(5000),
        businessName: "b".repeat(200),
      });

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects before any rate-limit counter is spent (length check precedes the limits)", async () => {
      await post({ ...validBody, comment: "x".repeat(5001) });

      expect(checkRateLimitMock).not.toHaveBeenCalled();
    });

    it("does not let a non-string comment/businessName smuggle a huge prompt past the cap", async () => {
      const huge = "z".repeat(5000);

      const response = await post({
        ...validBody,
        comment: [huge],
        businessName: { huge },
      });

      expect(response.status).toBe(200);
      expect(JSON.stringify(sentBody().messages)).not.toContain("zzzzzzzzzz");
    });

    it("rejects a non-string reviewer name as missing rather than interpolating it", async () => {
      const response = await post({ ...validBody, reviewerName: ["z".repeat(5000)] });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Reviewer name and star rating are required",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("per-workspace daily quota", () => {
    it("returns 429 AI_WORKSPACE_DAILY_LIMIT when the workspace quota is spent, without calling the provider", async () => {
      checkRateLimitMock.mockImplementation(async (opts: { userId: string }) =>
        opts.userId.startsWith("ai:workspace:")
          ? { allowed: false, retryAfterSeconds: 5400 }
          : { allowed: true },
      );

      const response = await post(validBody);

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("5400");
      await expect(response.json()).resolves.toEqual({
        code: "AI_WORKSPACE_DAILY_LIMIT",
        error: "Your workspace has reached today's AI limit. Try again tomorrow.",
        retryAfterSeconds: 5400,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("counts against the caller's workspace and keeps the per-user key unchanged", async () => {
      await post(validBody);

      const calls = checkRateLimitMock.mock.calls.map(([opts]) => opts);
      expect(calls).toContainEqual(
        expect.objectContaining({ userId: "user-1", route: "reviews/draft-response", limit: 20 }),
      );
      expect(calls).toContainEqual(
        expect.objectContaining({ userId: "ai:workspace:ws-1", limit: 200 }),
      );
    });

    it("does not spend workspace quota on a request that fails validation", async () => {
      await post({ comment: "hi" });

      const keys = checkRateLimitMock.mock.calls.map(([opts]) => opts.userId);
      expect(keys).not.toContain("ai:workspace:ws-1");
    });
  });

  describe("provider call", () => {
    it("sends reasoning_effort: 'low' to xAI grok-4.5", async () => {
      await post(validBody);

      expect(sentBody()).toMatchObject({ model: "grok-4.5", reasoning_effort: "low" });
    });

    it("sends nothing extra for an xAI model that is not a reasoning model", async () => {
      vi.stubEnv("XAI_TEXT_MODEL", "grok-4.20-0309-non-reasoning");

      await post(validBody);

      expect(sentBody()).not.toHaveProperty("reasoning_effort");
    });

    it("never sends reasoning_effort to the OpenAI fallback provider", async () => {
      vi.stubEnv("XAI_API_KEY", "");
      vi.stubEnv("OPENAI_API_KEY", "openai-key");

      await post(validBody);

      const body = sentBody();
      expect(body.model).toBe("gpt-4o-mini");
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/chat/completions");
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
  });
});
