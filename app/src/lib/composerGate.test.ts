import { describe, expect, it } from "vitest";

import { deriveComposerGate } from "./composerGate";

import type { ConnectionStatus } from "./connectionsDto";

function connection(overrides: Partial<ConnectionStatus> = {}): ConnectionStatus {
  return {
    platform: "google_business_profile",
    connected: true,
    needsReconnect: false,
    ...overrides,
  } as ConnectionStatus;
}

describe("deriveComposerGate", () => {
  it("shows the loading skeleton while the first connections fetch is in flight", () => {
    // The bug this rule exists to prevent: rendering the full form during the
    // initial fetch lets the user attach a file that a later zero-connection
    // resolution silently discards.
    expect(deriveComposerGate(null, true)).toBe("loading");
  });

  it("shows the connect CTA when connections resolved to zero connected platforms", () => {
    expect(deriveComposerGate([], false)).toBe("connect");
    expect(deriveComposerGate([connection({ connected: false })], false)).toBe("connect");
  });

  it("shows the form when at least one platform is connected", () => {
    expect(deriveComposerGate([connection()], false)).toBe("form");
  });

  it("falls back to the form when the fetch failed (never a permanent skeleton)", () => {
    // ux-sweep lesson: a failed fetch leaves data null with loading false —
    // gating on "resolved" alone would park a skeleton on screen forever.
    expect(deriveComposerGate(null, false)).toBe("form");
  });

  it("keeps showing resolved content during a refetch (stale data beats a blank)", () => {
    expect(deriveComposerGate([connection()], true)).toBe("form");
    expect(deriveComposerGate([], true)).toBe("connect");
  });
});
