import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectLinkFlow } from "./connectLink";
import { createConnectLinkState, createOAuthState, readConnectLinkState, verifyOAuthState } from "./oauthState";

/**
 * Client connect link (16): a link flow's state is signed with a key derived
 * from the secret, in its own envelope, so it never verifies as an ordinary
 * state. A callback that was never taught about links, and the code live
 * before this release, refuse it as an invalid state.
 */

const LINK: ConnectLinkFlow = {
  id: "link-1",
  nonce: "nonce-1",
  userId: "user-creator",
  workspaceId: "ws-1",
  token: "T".repeat(43),
};

function linkState(overrides: Partial<{ linkId: string; nonce: string; userId: string; workspaceId: string }> = {}) {
  return createConnectLinkState({
    linkId: LINK.id,
    nonce: LINK.nonce,
    userId: LINK.userId,
    workspaceId: LINK.workspaceId,
    ...overrides,
  });
}

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-nextauth-secret-value");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("verifyOAuthState and the connect link", () => {
  it("an ordinary state with no link is verified as today", () => {
    const state = createOAuthState({ userId: "user-123", workspaceId: "ws-1" });
    expect(verifyOAuthState(state)).toEqual({ valid: true, userId: "user-123", workspaceId: "ws-1" });
    expect(verifyOAuthState(state, null)).toEqual({ valid: true, userId: "user-123", workspaceId: "ws-1" });
  });

  it("a link state without its link is invalid, called the way the callbacks call it today", () => {
    expect(verifyOAuthState(linkState())).toEqual({ valid: false });
    expect(verifyOAuthState(linkState(), null)).toEqual({ valid: false });
  });

  it("a link state with its link is valid and names the creator and the workspace", () => {
    expect(verifyOAuthState(linkState(), LINK)).toEqual({
      valid: true,
      userId: "user-creator",
      workspaceId: "ws-1",
    });
  });

  it("an ordinary state is not accepted for a link flow", () => {
    const state = createOAuthState({ userId: LINK.userId, workspaceId: LINK.workspaceId });
    expect(verifyOAuthState(state, LINK)).toEqual({ valid: false });
  });

  it("another link's id or nonce, or other ids, is invalid", () => {
    expect(verifyOAuthState(linkState({ linkId: "link-2" }), LINK)).toEqual({ valid: false });
    expect(verifyOAuthState(linkState({ nonce: "nonce-2" }), LINK)).toEqual({ valid: false });
    expect(verifyOAuthState(linkState({ userId: "user-other" }), LINK)).toEqual({ valid: false });
    expect(verifyOAuthState(linkState({ workspaceId: "ws-2" }), LINK)).toEqual({ valid: false });
  });

  it("an expired link state is invalid (10 minutes, as an ordinary state)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T08:00:00Z"));
    const state = linkState();
    vi.setSystemTime(new Date("2026-11-11T08:10:01Z"));
    expect(verifyOAuthState(state, LINK)).toEqual({ valid: false });
    expect(readConnectLinkState(state)).toBeNull();
  });

  it("a tampered link state is invalid", () => {
    const wrapped = JSON.parse(Buffer.from(linkState(), "base64url").toString("utf8")) as Record<string, string>;
    const payload = JSON.parse(wrapped.p) as Record<string, unknown>;
    payload.workspaceId = "ws-attacker";
    const tampered = Buffer.from(JSON.stringify({ ...wrapped, p: JSON.stringify(payload) })).toString("base64url");
    expect(verifyOAuthState(tampered, { ...LINK, workspaceId: "ws-attacker" })).toEqual({ valid: false });
    expect(readConnectLinkState(tampered)).toBeNull();
  });

  it("a link state signed with the plain secret (an ordinary state re-wrapped) is not a link state", () => {
    const ordinary = JSON.parse(
      Buffer.from(createOAuthState({ userId: LINK.userId, workspaceId: LINK.workspaceId }), "base64url").toString("utf8"),
    ) as Record<string, string>;
    const rewrapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(linkState(), "base64url").toString()), s: ordinary.s })).toString("base64url");
    expect(readConnectLinkState(rewrapped)).toBeNull();
  });

  it("is one base64url segment with no dot, so LinkedIn's state split leaves it whole", () => {
    expect(linkState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never carries the raw link token", () => {
    const decoded = Buffer.from(linkState(), "base64url").toString("utf8");
    expect(decoded).not.toContain(LINK.token);
  });

  it("reads back the link id, nonce and ids from a link state, and null from an ordinary one", () => {
    expect(readConnectLinkState(linkState())).toEqual({
      linkId: "link-1",
      nonce: "nonce-1",
      userId: "user-creator",
      workspaceId: "ws-1",
    });
    expect(readConnectLinkState(createOAuthState({ userId: "u", workspaceId: "w" }))).toBeNull();
    expect(readConnectLinkState("not-a-state")).toBeNull();
  });
});
