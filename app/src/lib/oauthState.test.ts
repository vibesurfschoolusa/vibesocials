import crypto from "crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOAuthState, verifyOAuthState } from "./oauthState";

const SECRET = "test-nextauth-secret-value";

function decodeState(state: string): { p: string; s: string } {
  return JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
    p: string;
    s: string;
  };
}

function encodeState(wrapped: { p: string; s: string }): string {
  return Buffer.from(JSON.stringify(wrapped), "utf8").toString("base64url");
}

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("oauthState", () => {
  it("round-trips a userId + workspaceId through create -> verify", () => {
    const state = createOAuthState({ userId: "user-123", workspaceId: "ws-1" });
    expect(verifyOAuthState(state)).toEqual({
      valid: true,
      userId: "user-123",
      workspaceId: "ws-1",
    });
  });

  it("rejects a state whose payload was tampered", () => {
    const state = createOAuthState({ userId: "user-123", workspaceId: "ws-1" });
    const decoded = decodeState(state);
    const payloadObj = JSON.parse(decoded.p) as { userId: string; workspaceId: string; ts: number };
    payloadObj.userId = "attacker";
    const tampered = encodeState({ p: JSON.stringify(payloadObj), s: decoded.s });

    expect(verifyOAuthState(tampered)).toEqual({ valid: false });
  });

  it("rejects a state whose signature was tampered", () => {
    const state = createOAuthState({ userId: "user-123", workspaceId: "ws-1" });
    const decoded = decodeState(state);
    // Flip the last hex char, preserving length so the length guard passes and
    // the timing-safe comparison is what rejects it.
    const lastChar = decoded.s.slice(-1);
    const replacement = lastChar === "0" ? "1" : "0";
    const badSig = decoded.s.slice(0, -1) + replacement;
    const tampered = encodeState({ p: decoded.p, s: badSig });

    expect(verifyOAuthState(tampered)).toEqual({ valid: false });
  });

  it("rejects a state older than the 10 minute max age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
    const state = createOAuthState({ userId: "user-123", workspaceId: "ws-1" });

    // 11 minutes later.
    vi.setSystemTime(new Date("2020-01-01T00:11:00.000Z"));
    expect(verifyOAuthState(state)).toEqual({ valid: false });
  });

  it("throws on create and returns invalid on verify when NEXTAUTH_SECRET is absent", () => {
    const validState = createOAuthState({ userId: "user-123", workspaceId: "ws-1" }); // secret still present here

    vi.stubEnv("NEXTAUTH_SECRET", "");
    expect(() => createOAuthState({ userId: "user-123", workspaceId: "ws-1" })).toThrow(
      /NEXTAUTH_SECRET/,
    );
    expect(verifyOAuthState(validState)).toEqual({ valid: false });
  });

  // Team Workspaces (Task 6, design §5): the state payload gained a required
  // `workspaceId`. Old-format states (pre-workspaces, no workspaceId) must
  // fail verification rather than silently resolving to `workspaceId:
  // undefined` — the 10-minute TTL makes a deploy-boundary mismatch a
  // non-event (an in-flight old-format state just dies and the user retries).
  describe("workspaceId is required (Team Workspaces)", () => {
    it("rejects a well-signed payload that has no workspaceId (old format)", () => {
      const secret = SECRET;
      const payload = JSON.stringify({ userId: "user-123", ts: Date.now() });
      const hmac = crypto.createHmac("sha256", secret);
      hmac.update(payload);
      const signature = hmac.digest("hex");
      const oldFormatState = Buffer.from(
        JSON.stringify({ p: payload, s: signature }),
        "utf8",
      ).toString("base64url");

      expect(verifyOAuthState(oldFormatState)).toEqual({ valid: false });
    });

    it("rejects a payload with an empty-string workspaceId", () => {
      const secret = SECRET;
      const payload = JSON.stringify({ userId: "user-123", workspaceId: "", ts: Date.now() });
      const hmac = crypto.createHmac("sha256", secret);
      hmac.update(payload);
      const signature = hmac.digest("hex");
      const state = Buffer.from(JSON.stringify({ p: payload, s: signature }), "utf8").toString(
        "base64url",
      );

      expect(verifyOAuthState(state)).toEqual({ valid: false });
    });

    it("includes workspaceId in the signed payload (round-trips through decode)", () => {
      const state = createOAuthState({ userId: "user-123", workspaceId: "ws-abc" });
      const decoded = decodeState(state);
      const payload = JSON.parse(decoded.p) as { userId: string; workspaceId: string; ts: number };
      expect(payload.workspaceId).toBe("ws-abc");
    });
  });
});
