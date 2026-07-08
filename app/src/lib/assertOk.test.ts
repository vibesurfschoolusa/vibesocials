import { afterEach, describe, expect, it, vi } from "vitest";

import { assertOk } from "./assertOk";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assertOk", () => {
  it("returns the response unchanged when ok", async () => {
    const response = new Response("body", { status: 200 });
    const result = await assertOk(response, { code: "X", prefix: "Should not throw" });
    expect(result).toBe(response);
    // The ok path must not consume the body — it must still be readable by the caller.
    expect(await result.text()).toBe("body");
  });

  it("throws a sanitized error that omits the upstream body but logs it server-side", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstreamBody = "SECRET_UPSTREAM_DETAILS_9c1f invalid_grant";
    const response = new Response(upstreamBody, {
      status: 401,
      statusText: "Unauthorized",
    });

    const error = await assertOk(response, {
      code: "MY_CODE",
      prefix: "Failed to refresh token",
    })
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error).toBeInstanceOf(Error);
    expect(error?.code).toBe("MY_CODE");
    // Sanitized message: prefix + status only, never the upstream body.
    expect(error?.message).toContain("Failed to refresh token");
    expect(error?.message).toContain("401");
    expect(error?.message).not.toContain(upstreamBody);

    // Raw body IS logged server-side for debugging.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(consoleSpy.mock.calls)).toContain(upstreamBody);
  });

  it("still throws the coded error when the body cannot be read", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.reject(new Error("stream error")),
    } as unknown as Response;

    const error = await assertOk(response, { code: "READ_FAIL", prefix: "Upstream failed" })
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("READ_FAIL");
    expect(error?.message).toContain("500");
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });
});
