import type { PostJobResult } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { decodePostsCursor, encodePostsCursor, toPostJobResultSummaryDto } from "./postsDto";

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
    errorCode: null,
    errorMessage: null,
    claimRunId: null,
    claimedAt: null,
    deferredUntil: null,
    metricsCheckedAt: null,
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
});
