import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";
import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";

import { commitRequest, publishUnconfirmedError, readCommitBody, requireCommitId } from "./commitCall";
import { PUBLISH_BUDGET_EXCEEDED_CODE, publishBudgetExceededError } from "./publishBudget";
import { classifyRateLimit } from "./rateLimited";
import { isTransientPublishError } from "./transientRetry";

// 2026-11-01 scale audit (jobs H6, Review Focus 5): a commit call is the one
// request that makes the post exist. Only a provably-unsent or rejected outcome
// may reach the retry / failure paths; everything ambiguous is
// PUBLISH_UNCONFIRMED and is never re-run.

type Unconfirmed = Error & { code?: string; cause?: unknown };

/** The error `commitRequest` rejects with, or null when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<Unconfirmed | null> {
  return promise.then(
    () => null,
    (e: unknown) => e as Unconfirmed,
  );
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publishUnconfirmedError", () => {
  it("carries the PUBLISH_UNCONFIRMED code and the shared message, with the cause attached", () => {
    const cause = new Error("socket hang up");

    const error = publishUnconfirmedError("x", cause);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(error.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect((error as Unconfirmed).cause).toBe(cause);
  });

  it("works without a cause", () => {
    const error = publishUnconfirmedError("linkedin");

    expect(error.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
  });

  it("is never transient: a re-run could double-post", () => {
    expect(isTransientPublishError(publishUnconfirmedError("x"))).toBe(false);
  });
});

describe("commitRequest — ambiguous outcomes become PUBLISH_UNCONFIRMED", () => {
  it.each([500, 502, 503, 504, 599])("an HTTP %i response throws PUBLISH_UNCONFIRMED, with a cause", async (status) => {
    const error = await rejection(commitRequest("youtube", () => Promise.resolve(new Response("oops", { status }))));

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect(error?.cause).toBeInstanceOf(Error);
    expect(error?.cause).toMatchObject({ status });
  });

  it("does not leak the upstream body into the error", async () => {
    const error = await rejection(
      commitRequest("x", () => Promise.resolve(new Response("SECRET_UPSTREAM_BODY", { status: 503 }))),
    );

    expect(error?.message).not.toContain("SECRET_UPSTREAM_BODY");
    expect(JSON.stringify(error?.cause, Object.getOwnPropertyNames(error?.cause ?? {}))).not.toContain(
      "SECRET_UPSTREAM_BODY",
    );
  });

  it("a FETCH_TIMEOUT (the platform may have received and committed it) throws PUBLISH_UNCONFIRMED", async () => {
    const timeout = Object.assign(new Error("Request timed out after 30000ms"), { code: FETCH_TIMEOUT_CODE });

    const error = await rejection(commitRequest("facebook_page", () => Promise.reject(timeout)));

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.cause).toBe(timeout);
  });

  it.each(["ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT"])(
    "a post-connect network error (%s) throws PUBLISH_UNCONFIRMED",
    async (code) => {
      const networkError = new TypeError("fetch failed", { cause: { code } });

      const error = await rejection(commitRequest("instagram", () => Promise.reject(networkError)));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.cause).toBe(networkError);
    },
  );

  it("a fetch TypeError without a cause code (cannot prove it never connected) throws PUBLISH_UNCONFIRMED", async () => {
    const error = await rejection(commitRequest("x", () => Promise.reject(new TypeError("fetch failed"))));

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
  });

  it("any other unexpected error is ambiguous too", async () => {
    const error = await rejection(commitRequest("tiktok", () => Promise.reject(new Error("boom"))));

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
  });

  it("an error thrown synchronously by the sender is classified the same way", async () => {
    const error = await rejection(
      commitRequest("tiktok", () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      }),
    );

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
  });

  it("an already-unconfirmed error passes through unwrapped", async () => {
    const already = publishUnconfirmedError("x", new Error("first"));

    const error = await rejection(commitRequest("x", () => Promise.reject(already)));

    expect(error).toBe(already);
  });
});

describe("commitRequest — provably-unsent outcomes are rethrown unchanged", () => {
  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"])(
    "a never-connected TypeError (%s) is rethrown as the same TypeError",
    async (code) => {
      const neverConnected = new TypeError("fetch failed", { cause: { code } });

      const error = await rejection(commitRequest("youtube", () => Promise.reject(neverConnected)));

      expect(error).toBe(neverConnected);
      // ...so the in-step retry may re-run it: nothing was sent.
      expect(isTransientPublishError(error)).toBe(true);
    },
  );

  it("a PUBLISH_TIME_BUDGET_EXCEEDED error (thrown before sending) is rethrown unchanged", async () => {
    const budget = publishBudgetExceededError();

    const error = await rejection(commitRequest("x", () => Promise.reject(budget)));

    expect(error).toBe(budget);
    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
  });

  it("a PUBLISH_TIME_BUDGET_EXCEEDED error thrown synchronously (budgetedTimeout) is rethrown unchanged", async () => {
    const budget = publishBudgetExceededError();
    const send = vi.fn((): Promise<Response> => {
      throw budget;
    });

    const error = await rejection(commitRequest("x", send));

    expect(error).toBe(budget);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("commitRequest — rejections are returned to the caller", () => {
  it.each([200, 201, 204, 400, 401, 403, 404, 422, 429])(
    "HTTP %i is returned as is (the caller classifies it or fails as before)",
    async (status) => {
      const response = new Response(status === 204 ? null : "{}", { status });

      await expect(commitRequest("linkedin", () => Promise.resolve(response))).resolves.toBe(response);
    },
  );

  it("a 429 stays readable, so classifyRateLimit can still turn it into RATE_LIMITED", async () => {
    const response = await commitRequest("x", () =>
      Promise.resolve(new Response("", { status: 429, headers: { "x-rate-limit-reset": "4102444800" } })),
    );

    const limited = await classifyRateLimit("x", response);

    expect(limited).toMatchObject({ code: "RATE_LIMITED", platform: "x", retryAt: 4102444800 * 1000 });
  });

  it("calls the sender exactly once", async () => {
    const send = vi.fn(() => Promise.resolve(new Response("", { status: 503 })));

    await rejection(commitRequest("google_business_profile", send));

    expect(send).toHaveBeenCalledTimes(1);
  });
});

// Review F4 (I2): the commit call answered 2xx, so the post may already be live.
// If reading or parsing the success body then fails, the outcome is unknown, not
// "failed": a plain error would invite a retry that double-posts.
describe("readCommitBody — a 2xx commit whose body cannot be read is PUBLISH_UNCONFIRMED", () => {
  it("parses a JSON body", async () => {
    const body = await readCommitBody<{ id: string }>("x", new Response('{"id":"42"}', { status: 200 }), "json");

    expect(body).toEqual({ id: "42" });
  });

  it("returns a text body", async () => {
    const body = await readCommitBody<string>("linkedin", new Response("urn:li:share:1", { status: 201 }), "text");

    expect(body).toBe("urn:li:share:1");
  });

  it("invalid JSON throws PUBLISH_UNCONFIRMED with the parse error as the cause", async () => {
    const error = await rejection(readCommitBody("youtube", new Response("<html>gateway</html>", { status: 200 }), "json"));

    expect(error?.code).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect(error?.cause).toBeInstanceOf(SyntaxError);
  });

  it("an empty 2xx body is not valid JSON either: PUBLISH_UNCONFIRMED", async () => {
    const error = await rejection(readCommitBody("instagram", new Response("", { status: 200 }), "json"));

    expect(error?.code).toBe(PUBLISH_UNCONFIRMED_CODE);
  });

  it("a body stream that errors mid-read throws PUBLISH_UNCONFIRMED (json)", async () => {
    const reset = new Error("terminated");
    const res = { json: () => Promise.reject(reset) } as unknown as Response;

    const error = await rejection(readCommitBody("facebook_page", res, "json"));

    expect(error?.code).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(error?.cause).toBe(reset);
  });

  it("a body stream that errors mid-read throws PUBLISH_UNCONFIRMED (text)", async () => {
    const reset = new Error("terminated");
    const res = { text: () => Promise.reject(reset) } as unknown as Response;

    const error = await rejection(readCommitBody("google_business_profile", res, "text"));

    expect(error?.code).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(error?.cause).toBe(reset);
  });

  it("a synchronous throw from the reader is caught too", async () => {
    const res = {
      json: () => {
        throw new Error("boom");
      },
    } as unknown as Response;

    const error = await rejection(readCommitBody("x", res, "json"));

    expect(error?.code).toBe(PUBLISH_UNCONFIRMED_CODE);
  });

  it("the thrown error is never transient: the in-step retry must not re-run the commit", async () => {
    const error = await rejection(readCommitBody("x", new Response("nope", { status: 200 }), "json"));

    expect(isTransientPublishError(error)).toBe(false);
  });

  it("does not leak the upstream body into the error message", async () => {
    const error = await rejection(readCommitBody("x", new Response("SECRET_UPSTREAM_BODY", { status: 200 }), "json"));

    expect(error?.message).not.toContain("SECRET_UPSTREAM_BODY");
  });
});

// 2026-11-02 scale audit (jobs, R30): a 2xx commit body that parsed but lacks the
// post id the client returns as externalPostId means the platform said "created"
// and we cannot say which post it is. Not a failure to retry: PUBLISH_UNCONFIRMED.
describe("requireCommitId", () => {
  it("returns a non-empty string id unchanged", () => {
    expect(requireCommitId("x", "abc", "data.id")).toBe("abc");
  });

  it.each([
    ["undefined", undefined],
    ["an empty string", ""],
    ["a number", 42],
    ["null", null],
    ["an object", { id: "abc" }],
  ])("%s throws PUBLISH_UNCONFIRMED with a cause naming the field", (_label, value) => {
    let thrown: Unconfirmed | null = null;
    try {
      requireCommitId("youtube", value, "id");
    } catch (e) {
      thrown = e as Unconfirmed;
    }

    expect(thrown?.code).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(thrown?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect((thrown?.cause as Error).message).toBe("2xx commit body without id");
  });

  it("the thrown error is never transient: the in-step retry must not re-run the commit", () => {
    let thrown: unknown;
    try {
      requireCommitId("x", undefined, "id_str");
    } catch (e) {
      thrown = e;
    }

    expect(isTransientPublishError(thrown)).toBe(false);
  });
});
