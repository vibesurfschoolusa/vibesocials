import { describe, expect, it } from "vitest";

import { deriveGettingStarted } from "./gettingStarted";
import type { ConnectionStatus } from "@/lib/connectionsDto";
import type { PostJobDTO } from "@/lib/postsDto";

// Same factory-with-overrides pattern as usePostJobs.test.ts — only the
// fields deriveGettingStarted actually reads (connection.connected,
// jobs.length) vary per test; everything else is a fixed, valid stand-in.
function connection(partial: Partial<ConnectionStatus> = {}): ConnectionStatus {
  return {
    platform: "youtube",
    connected: false,
    needsReconnect: false,
    ...partial,
  };
}

function job(partial: Partial<PostJobDTO> = {}): PostJobDTO {
  return {
    id: "job",
    status: "completed",
    createdAt: "2026-07-10T00:00:00.000Z",
    scheduledFor: null,
    caption: "c",
    results: [],
    media: null,
    publish: null,
    createdBy: null,
    ...partial,
  };
}

describe("deriveGettingStarted", () => {
  it("is not ready (and hidden) while either source is still null", () => {
    expect(deriveGettingStarted(null, null)).toMatchObject({
      ready: false,
      show: false,
    });
    expect(deriveGettingStarted([], null)).toMatchObject({
      ready: false,
      show: false,
    });
    expect(deriveGettingStarted(null, [])).toMatchObject({
      ready: false,
      show: false,
    });
  });

  it("shows with both steps open for a brand-new user (loaded, nothing done)", () => {
    expect(deriveGettingStarted([connection()], [])).toEqual({
      ready: true,
      connectDone: false,
      postDone: false,
      complete: false,
      show: true,
    });
  });

  it("marks connect done when at least one platform is connected", () => {
    const state = deriveGettingStarted(
      [connection(), connection({ platform: "x", connected: true })],
      [],
    );
    expect(state.connectDone).toBe(true);
    expect(state.postDone).toBe(false);
    expect(state.show).toBe(true);
  });

  it("a connections list of all-disconnected rows does NOT count as connected", () => {
    const state = deriveGettingStarted(
      [connection(), connection({ platform: "x" })],
      [],
    );
    expect(state.connectDone).toBe(false);
  });

  it("marks post done for any job, including a draft that never published", () => {
    const state = deriveGettingStarted([connection()], [job({ status: "draft" })]);
    expect(state.postDone).toBe(true);
    expect(state.connectDone).toBe(false);
    expect(state.show).toBe(true);
  });

  it("hides once both steps are done (user reached first value)", () => {
    expect(
      deriveGettingStarted([connection({ connected: true })], [job()]),
    ).toEqual({
      ready: true,
      connectDone: true,
      postDone: true,
      complete: true,
      show: false,
    });
  });
});
