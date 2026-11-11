import type { PostJobResult } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  decodePostsCursor,
  encodePostsCursor,
  isUnconfirmedResult,
  seriesPlaces,
  toPostJobResultSummaryDto,
} from "./postsDto";

/**
 * Pure unit tests for the keyset pagination cursor helpers (activity
 * pagination). These carry no DB/route machinery — the cursor is a pure
 * function of a job's (createdAt, id) total-order key.
 */
describe("postsDto cursor helpers (activity pagination)", () => {
  it("round-trips a (createdAt, id) pair through encode -> decode", () => {
    const createdAt = new Date("2026-07-10T12:34:56.789Z");
    const id = "ckpostjob123";

    const decoded = decodePostsCursor(encodePostsCursor(createdAt, id));

    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe(id);
    // Compared by instant — decode rebuilds the Date from the ISO string.
    expect(decoded?.createdAt.toISOString()).toBe(createdAt.toISOString());
  });

  it("emits a URL-safe (base64url) token — no +, /, or = padding to break a query string", () => {
    const token = encodePostsCursor(new Date("2026-07-10T12:34:56.789Z"), "id-with-+/=chars");
    expect(token).not.toMatch(/[+/=]/);
  });

  it("returns null for a token missing the createdAt|id separator", () => {
    const noSeparator = Buffer.from("2026-07-10T12:34:56.789Z").toString("base64url");
    expect(decodePostsCursor(noSeparator)).toBeNull();
  });

  it("returns null when the timestamp part is not a valid date", () => {
    const badDate = Buffer.from("not-a-date|ckpostjob123").toString("base64url");
    expect(decodePostsCursor(badDate)).toBeNull();
  });

  it("returns null for a valid date but an empty id", () => {
    const emptyId = Buffer.from("2026-07-10T12:34:56.789Z|").toString("base64url");
    expect(decodePostsCursor(emptyId)).toBeNull();
  });

  it("returns null for arbitrary garbage that is not a valid cursor", () => {
    expect(decodePostsCursor("")).toBeNull();
    expect(decodePostsCursor("garbage")).toBeNull();
    expect(decodePostsCursor("!!!not base64!!!")).toBeNull();
  });

  it("splits on the FIRST separator so an id is preserved verbatim", () => {
    // Real cuid ids never contain '|', but the decoder must not choke if extra
    // separators appear — everything after the first '|' is the id.
    const createdAt = new Date("2026-07-10T12:34:56.789Z");
    const token = Buffer.from(`${createdAt.toISOString()}|a|b`).toString("base64url");
    const decoded = decodePostsCursor(token);
    expect(decoded?.id).toBe("a|b");
    expect(decoded?.createdAt.toISOString()).toBe(createdAt.toISOString());
  });
});

/**
 * 2026-11-01 audit, Task 5: `PostJobResult.socialConnectionId` is nullable
 * (onDelete: SetNull) so a result outlives a removed connection. The display
 * DTO never carried the FK; a null one must map exactly like a present one.
 */
describe("toPostJobResultSummaryDto — results whose connection was removed", () => {
  const row = (socialConnectionId: string | null): PostJobResult => ({
    id: "result-1",
    postJobId: "job-1",
    platform: "youtube",
    socialConnectionId,
    status: "success",
    externalPostId: "yt-123",
    externalPostUrl: null,
    errorCode: null,
    errorMessage: null,
    claimRunId: null,
    claimedAt: null,
    deferredUntil: null,
    metricsCheckedAt: null,
    workspaceId: "workspace-1",
    uploadState: null,
    createdAt: new Date("2026-01-01T00:01:00Z"),
    updatedAt: new Date("2026-01-01T00:01:30Z"),
  });

  it("maps a null connection id to the same display shape as a present one", () => {
    const expected = {
      platform: "youtube",
      status: "success",
      externalPostId: "yt-123",
      errorMessage: null,
    };
    expect(toPostJobResultSummaryDto(row(null))).toEqual(expected);
    expect(toPostJobResultSummaryDto(row("conn-1"))).toEqual(expected);
  });

  // 2026-11-02 scale audit (jobs, chunked uploads): `uploadState` holds the sealed
  // capability URLs of an upload in progress. Both posts routes map whole result
  // rows through this function, so it must stay an allow-list.
  it("never carries the saved upload state of an upload in progress", () => {
    const withState: PostJobResult = {
      ...row("conn-1"),
      status: "pending",
      uploadState: { v: 1, runId: "run-1", data: { confirmed: 5 }, secret: "enc:v1:AAAA" },
    };

    const dto = toPostJobResultSummaryDto(withState);

    expect(Object.keys(dto).sort()).toEqual(["errorMessage", "externalPostId", "platform", "status"]);
    expect(JSON.stringify(dto)).not.toContain("enc:v1");
  });
});

// 2026-11-01 scale audit (jobs H6) + final review F4: a failed result whose commit
// call could not be confirmed tells the Activity card to warn inline. TikTok's
// TIKTOK_PUBLISH_PENDING ("not confirmed or denied") is the same situation.
describe("isUnconfirmedResult", () => {
  it.each(["PUBLISH_UNCONFIRMED", "TIKTOK_PUBLISH_PENDING"])("a failed result with %s is unconfirmed", (errorCode) => {
    expect(isUnconfirmedResult({ status: "failed", errorCode })).toBe(true);
  });

  it.each(["pending", "success"] as const)("a %s result is never unconfirmed, whatever its code", (status) => {
    expect(isUnconfirmedResult({ status, errorCode: "PUBLISH_UNCONFIRMED" })).toBe(false);
    expect(isUnconfirmedResult({ status, errorCode: "TIKTOK_PUBLISH_PENDING" })).toBe(false);
  });

  it.each([null, "X_TWEET_FAILED", "RATE_LIMITED", "PUBLISH_INTERRUPTED", "PUBLISH_STALLED", "TIKTOK_UPLOAD_FAILED"])(
    "a failed result with %j is not unconfirmed",
    (errorCode) => {
      expect(isUnconfirmedResult({ status: "failed", errorCode })).toBe(false);
    },
  );
});

// 11: "Repeats: 3 of 8" is counted over the series' posts that still exist.
describe("seriesPlaces", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 10, day, 9, 0));

  it("numbers each post by its time among the posts of its series that exist", () => {
    const places = seriesPlaces([
      { id: "c", seriesId: "s1", scheduledFor: at(26) },
      { id: "a", seriesId: "s1", scheduledFor: at(12) },
      { id: "b", seriesId: "s1", scheduledFor: at(19) },
      { id: "x", seriesId: "s2", scheduledFor: at(13) },
    ]);
    expect(places.get("a")).toEqual({ position: 1, count: 3 });
    expect(places.get("b")).toEqual({ position: 2, count: 3 });
    expect(places.get("c")).toEqual({ position: 3, count: 3 });
    expect(places.get("x")).toEqual({ position: 1, count: 1 });
  });

  it("a deleted post no longer counts", () => {
    const places = seriesPlaces([
      { id: "a", seriesId: "s1", scheduledFor: at(12) },
      { id: "c", seriesId: "s1", scheduledFor: at(26) },
    ]);
    expect(places.get("c")).toEqual({ position: 2, count: 2 });
  });

  it("a post without a time goes last, and ties keep id order", () => {
    const places = seriesPlaces([
      { id: "b", seriesId: "s1", scheduledFor: null },
      { id: "d", seriesId: "s1", scheduledFor: at(12) },
      { id: "c", seriesId: "s1", scheduledFor: at(12) },
    ]);
    expect(places.get("c")).toEqual({ position: 1, count: 3 });
    expect(places.get("d")).toEqual({ position: 2, count: 3 });
    expect(places.get("b")).toEqual({ position: 3, count: 3 });
  });

  it("ignores posts without a series", () => {
    expect(seriesPlaces([{ id: "a", seriesId: null, scheduledFor: at(12) }]).size).toBe(0);
  });
});

// 11 polish: cancelled posts leave the count; published ones stay.
describe("seriesPlaces leaves cancelled posts out", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 10, day, 9, 0));
  const series = (statuses: string[]) =>
    statuses.map((status, i) => ({ id: `p${i + 1}`, seriesId: "s1", scheduledFor: at(i + 1), status }));

  it("a full series", () => {
    const places = seriesPlaces(series(["completed", "scheduled", "scheduled", "scheduled"]));
    expect(places.get("p1")).toEqual({ position: 1, count: 4 });
    expect(places.get("p4")).toEqual({ position: 4, count: 4 });
  });

  it("after cancelling from the third on, the first two read 1 of 2 and 2 of 2", () => {
    const places = seriesPlaces(series(["completed", "scheduled", "cancelled", "cancelled", "cancelled"]));
    expect(places.get("p1")).toEqual({ position: 1, count: 2 });
    expect(places.get("p2")).toEqual({ position: 2, count: 2 });
    expect(places.has("p3")).toBe(false);
  });

  it("after one in the middle is cancelled alone", () => {
    const places = seriesPlaces(series(["scheduled", "cancelled", "scheduled"]));
    expect(places.get("p1")).toEqual({ position: 1, count: 2 });
    expect(places.get("p3")).toEqual({ position: 2, count: 2 });
  });

  it("only one post left", () => {
    const places = seriesPlaces(series(["cancelled", "scheduled", "cancelled"]));
    expect(places.get("p2")).toEqual({ position: 1, count: 1 });
  });
});

describe("toPostJobDetailDto - a post without a file", () => {
  it("reports a null mediaItemId", async () => {
    const { toPostJobDetailDto } = await import("./postsDto");
    const dto = toPostJobDetailDto({
      id: "job-1",
      status: "draft",
      createdAt: new Date("2026-11-10T00:00:00Z"),
      scheduledFor: null,
      baseCaption: "Wind is onshore",
      perPlatformOverrides: null,
      mediaItemId: null,
    } as Parameters<typeof toPostJobDetailDto>[0]);
    expect(dto.mediaItemId).toBeNull();
  });
});
