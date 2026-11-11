import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: vi.fn() }));

import { adminNotFoundResponse } from "@/lib/operator";
import * as pauseRoute from "../admin/workspaces/[id]/pause/route";

import * as catchAll from "./route";

/**
 * An unknown API path and a refused admin route must be indistinguishable
 * (fix round 1, 2026-11-10): same status, same body, same content type.
 */

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

async function shape(response: Response) {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    allow: response.headers.get("allow"),
    body: await response.text(),
  };
}

function request(method: string) {
  return new Request("http://localhost/api/anything", {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
  });
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  process.env.ADMIN_EMAILS = "ops@example.com";
  getCurrentUserMock.mockResolvedValue({ id: "u-1", email: "someone@example.com", emailVerifiedAt: new Date() });
});

describe("the API catch-all", () => {
  it.each(METHODS)("answers %s exactly as the admin refusal does", async (method) => {
    const handler = catchAll[method];
    expect(handler, method).toBeTypeOf("function");
    const expected = await shape(adminNotFoundResponse());
    expect(expected).toEqual({
      status: 404,
      contentType: "application/json",
      allow: null,
      body: JSON.stringify({ error: "Not found" }),
    });
    expect(await shape(await handler())).toEqual(expected);
  });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)(
    "matches what a signed-in customer gets from a real admin route by %s",
    async (method) => {
      const admin = await pauseRoute[method](request(method), { params: Promise.resolve({ id: "ws-1" }) });
      expect(await shape(await catchAll[method]())).toEqual(await shape(admin));
    },
  );
});
