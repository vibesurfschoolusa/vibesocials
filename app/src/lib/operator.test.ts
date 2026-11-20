import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentUserMock, checkRateLimitMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));
vi.mock("./auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("./rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));

import { NextResponse } from "next/server";

import { adminNotFoundResponse, checkAdminRateLimit, getOperator, isOperatorUser, parseAdminEmails, requireOperator } from "./operator";

function user(email: string, verified = true) {
  return {
    id: "user-1",
    email,
    emailVerifiedAt: verified ? new Date("2026-11-01T00:00:00Z") : null,
  };
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  checkRateLimitMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  delete process.env.ADMIN_EMAILS;
});

afterEach(() => {
  delete process.env.ADMIN_EMAILS;
});

describe("parseAdminEmails", () => {
  it("splits on commas, trims and lower-cases, and drops empties", () => {
    expect([...parseAdminEmails(" Ops@Example.com , ,second@example.com,")]).toEqual([
      "ops@example.com",
      "second@example.com",
    ]);
  });

  it("is empty for unset or blank", () => {
    expect(parseAdminEmails(undefined).size).toBe(0);
    expect(parseAdminEmails("   ").size).toBe(0);
  });
});

describe("isOperatorUser (pure)", () => {
  const verified = new Date("2026-11-01T00:00:00Z");

  it("is true only for a listed, verified email", () => {
    const env = { ADMIN_EMAILS: "ops@example.com" };
    expect(isOperatorUser({ email: "ops@example.com", emailVerifiedAt: verified }, env)).toBe(true);
    expect(isOperatorUser({ email: "ops@example.com", emailVerifiedAt: null }, env)).toBe(false);
    expect(isOperatorUser({ email: "someone@example.com", emailVerifiedAt: verified }, env)).toBe(false);
  });

  it("is false for everyone with the list unset, empty or blank", () => {
    const user = { email: "ops@example.com", emailVerifiedAt: verified };
    expect(isOperatorUser(user, {})).toBe(false);
    expect(isOperatorUser(user, { ADMIN_EMAILS: "" })).toBe(false);
    expect(isOperatorUser(user, { ADMIN_EMAILS: " , " })).toBe(false);
  });

  it("ignores case and spaces in the list and the email", () => {
    expect(
      isOperatorUser({ email: " Ops@EXAMPLE.com ", emailVerifiedAt: verified }, { ADMIN_EMAILS: " OPS@example.COM ,x@example.com" }),
    ).toBe(true);
  });

  it("reads process.env by default, at call time", () => {
    const user = { email: "ops@example.com", emailVerifiedAt: verified };
    process.env.ADMIN_EMAILS = "ops@example.com";
    expect(isOperatorUser(user)).toBe(true);
    process.env.ADMIN_EMAILS = "other@example.com";
    expect(isOperatorUser(user)).toBe(false);
  });
});

describe("getOperator", () => {
  it("is the operator when listed and verified", async () => {
    process.env.ADMIN_EMAILS = "ops@example.com";
    getCurrentUserMock.mockResolvedValue(user("ops@example.com"));
    expect(await getOperator()).toEqual({ userId: "user-1", email: "ops@example.com" });
  });

  it("is null when listed but the email is not verified", async () => {
    process.env.ADMIN_EMAILS = "ops@example.com";
    getCurrentUserMock.mockResolvedValue(user("ops@example.com", false));
    expect(await getOperator()).toBeNull();
  });

  it("is null when not listed", async () => {
    process.env.ADMIN_EMAILS = "ops@example.com";
    getCurrentUserMock.mockResolvedValue(user("someone@example.com"));
    expect(await getOperator()).toBeNull();
  });

  it("is null when signed out", async () => {
    process.env.ADMIN_EMAILS = "ops@example.com";
    getCurrentUserMock.mockResolvedValue(null);
    expect(await getOperator()).toBeNull();
  });

  it("is null for everyone when the list is unset or empty, without reading the session", async () => {
    getCurrentUserMock.mockResolvedValue(user("ops@example.com"));
    expect(await getOperator()).toBeNull();
    process.env.ADMIN_EMAILS = "";
    expect(await getOperator()).toBeNull();
    process.env.ADMIN_EMAILS = " , ";
    expect(await getOperator()).toBeNull();
    expect(getCurrentUserMock).not.toHaveBeenCalled();
  });

  it("ignores case and spaces in both the list and the email", async () => {
    process.env.ADMIN_EMAILS = "  OPS@Example.COM ,other@example.com";
    getCurrentUserMock.mockResolvedValue(user(" Ops@EXAMPLE.com "));
    expect(await getOperator()).toEqual({ userId: "user-1", email: "ops@example.com" });
  });

  it("reads the list at request time", async () => {
    getCurrentUserMock.mockResolvedValue(user("ops@example.com"));
    process.env.ADMIN_EMAILS = "ops@example.com";
    expect(await getOperator()).not.toBeNull();
    process.env.ADMIN_EMAILS = "other@example.com";
    expect(await getOperator()).toBeNull();
  });

  it("does not match a listed address as a part of another", async () => {
    process.env.ADMIN_EMAILS = "ops@example.com";
    getCurrentUserMock.mockResolvedValue(user("xops@example.com"));
    expect(await getOperator()).toBeNull();
  });
});

describe("adminNotFoundResponse", () => {
  it("is a plain 404 JSON body", async () => {
    const response = adminNotFoundResponse();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

describe("requireOperator", () => {
  it("answers a non-operator with the plain 404 and counts nothing", async () => {
    process.env.ADMIN_EMAILS = "ops@example.com";
    getCurrentUserMock.mockResolvedValue(user("someone@example.com"));
    const result = await requireOperator("change");
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(404);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it("limits reads to 120 and changes to 30 an hour per operator, failing closed", async () => {
    process.env.ADMIN_EMAILS = "ops@example.com";
    getCurrentUserMock.mockResolvedValue(user("ops@example.com"));

    // The two admin pages count reads themselves and word their own refusal.
    await checkAdminRateLimit({ userId: "user-1", email: "ops@example.com" }, "read");
    expect(checkRateLimitMock).toHaveBeenLastCalledWith({
      userId: "user-1",
      route: "admin/read",
      limit: 120,
      windowMs: 3_600_000,
      failClosed: true,
    });

    expect(await requireOperator("change")).toEqual({ userId: "user-1", email: "ops@example.com" });
    expect(checkRateLimitMock).toHaveBeenLastCalledWith({
      userId: "user-1",
      route: "admin/change",
      limit: 30,
      windowMs: 3_600_000,
      failClosed: true,
    });
  });

  it("answers 429 when the operator is over the limit", async () => {
    process.env.ADMIN_EMAILS = "ops@example.com";
    getCurrentUserMock.mockResolvedValue(user("ops@example.com"));
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 12 });
    const result = (await requireOperator("change")) as NextResponse;
    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("12");
  });

  // R46 pages-a L2 (second half): the hour is a fixed window, so the refusal names the real wait.
  it("over the limit at 40 minutes left: names the wait, with Retry-After", async () => {
    // Only changes go through requireOperator, so its one reason is about changes.
    const source = readFileSync(join(__dirname, "operator.ts"), "utf8");
    expect(source).not.toContain("pages opened");
    expect(source).toMatch(/export async function requireOperator\(kind: "change"\)/);

    process.env.ADMIN_EMAILS = "ops@example.com";
    getCurrentUserMock.mockResolvedValue(user("ops@example.com"));
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 2400 });

    const change = (await requireOperator("change")) as NextResponse;
    expect(change.status).toBe(429);
    expect(change.headers.get("Retry-After")).toBe("2400");
    await expect(change.json()).resolves.toEqual({
      error: "Too many changes this hour. Too many tries. Wait 40 minutes, then try again.",
      retryAfterSeconds: 2400,
    });
  });

  // R38 new-customer L1: a counter store that couldn't answer is not a used-up hour.
  it("answers 503 couldn't-check when the counter store couldn't answer", async () => {
    process.env.ADMIN_EMAILS = "ops@example.com";
    getCurrentUserMock.mockResolvedValue(user("ops@example.com"));
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60, unavailable: true });
    const result = (await requireOperator("change")) as NextResponse;
    expect(result.status).toBe(503);
    await expect(result.json()).resolves.toEqual({
      error: "We couldn't check that just now. Nothing was changed. Try again in a minute.",
    });
  });
});
