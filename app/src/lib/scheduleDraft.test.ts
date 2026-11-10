import { describe, expect, it } from "vitest";

import { scheduleDraft, type FetchLike, type ScheduleDraftResult } from "./scheduleDraft";

const SCHEDULED_AT = "2026-12-01T10:00:00.000Z";

/** A scripted step: a Response to return, or an Error to throw (network failure). */
type Step = Response | Error;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Records every call and plays the scripted steps in order. */
function fakeFetch(steps: Step[]) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, body: JSON.parse(init.body) });
    const step = steps[calls.length - 1];
    if (!step) throw new Error(`unexpected fetch #${calls.length} to ${url}`);
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchFn, calls };
}

const PATCH_CALL = { method: "PATCH", url: "/api/posts/job-1", body: { baseCaption: "New caption" } };
const PUBLISH_CALL = {
  method: "POST",
  url: "/api/posts/job-1/publish",
  body: { scheduledFor: SCHEDULED_AT },
};

function run(
  steps: Step[],
  overrides: Partial<Parameters<typeof scheduleDraft>[0]> = {},
) {
  const { fetchFn, calls } = fakeFetch(steps);
  const promise = scheduleDraft({
    fetchFn,
    jobId: "job-1",
    caption: "New caption",
    originalCaption: "Old caption",
    scheduledForIso: SCHEDULED_AT,
    submitsForApproval: false,
    ...overrides,
  });
  return promise.then((result) => ({ result, calls }));
}

describe("scheduleDraft — (a) PATCH the caption only if it changed", () => {
  it("changed caption: PATCH first, then publish with scheduledFor", async () => {
    const { calls } = await run([json(200, { ok: true }), json(200, { ok: true, status: "scheduled", scheduledFor: SCHEDULED_AT })]);
    expect(calls).toEqual([PATCH_CALL, PUBLISH_CALL]);
  });

  const unchanged: Array<[string, string | null, string]> = [
    ["identical", "New caption", "New caption"],
    ["only surrounding whitespace differs", "  New caption ", "New caption"],
    ["no original caption and an empty new one", null, ""],
  ];
  it.each(unchanged)("unchanged caption (%s): no PATCH, only publish", async (_name, original, caption) => {
    const { calls } = await run(
      [json(200, { ok: true, status: "scheduled", scheduledFor: SCHEDULED_AT })],
      { originalCaption: original, caption },
    );
    expect(calls).toEqual([PUBLISH_CALL]);
  });
});

describe("scheduleDraft — (b) a failed PATCH never reaches publish", () => {
  it("surfaces the server's error and reports the caption as NOT saved", async () => {
    const { result, calls } = await run([json(409, { error: "This post can no longer be edited.", code: "NOT_EDITABLE" })]);
    expect(calls).toEqual([PATCH_CALL]);
    expect(result).toEqual({
      kind: "failed",
      reason: "caption_save_failed",
      error: "This post can no longer be edited.",
      captionSaved: false,
    });
  });

  it("falls back to a generic message when the error body is unreadable", async () => {
    const { result, calls } = await run([new Response("<html>oops</html>", { status: 500 })]);
    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      kind: "failed",
      reason: "caption_save_failed",
      error: "Couldn't save your changes.",
      captionSaved: false,
    });
  });
});

describe("scheduleDraft — (c)/(d) a failed publish reports the server error and what already landed", () => {
  const rows: Array<[string, Step[], Partial<Parameters<typeof scheduleDraft>[0]>, ScheduleDraftResult]> = [
    [
      "caption PATCH landed, publish 409: error surfaced, caption reported saved (partial-save patch)",
      [json(200, { ok: true }), json(409, { code: "AWAITING_APPROVAL", error: "This post is waiting for an owner's approval." })],
      {},
      {
        kind: "failed",
        reason: "publish_failed",
        error: "This post is waiting for an owner's approval.",
        captionSaved: true,
      },
    ],
    [
      "caption PATCH landed, publish 503 DISPATCH_FAILED",
      [json(200, { ok: true }), json(503, { code: "DISPATCH_FAILED", error: "Couldn't start publishing. Please try again." })],
      {},
      {
        kind: "failed",
        reason: "publish_failed",
        error: "Couldn't start publishing. Please try again.",
        captionSaved: true,
      },
    ],
    [
      "caption unchanged (no PATCH), publish 400 past time: nothing was saved",
      [json(400, { error: "Scheduled time must be in the future." })],
      { originalCaption: "New caption" },
      {
        kind: "failed",
        reason: "publish_failed",
        error: "Scheduled time must be in the future.",
        captionSaved: false,
      },
    ],
    [
      "no error text, plain scheduling: generic schedule fallback",
      [json(200, { ok: true }), new Response("nope", { status: 500 })],
      { submitsForApproval: false },
      {
        kind: "failed",
        reason: "publish_failed",
        error: "Couldn't schedule this post.",
        captionSaved: true,
      },
    ],
    [
      "no error text, held member: approval-flavoured fallback",
      [json(200, { ok: true }), new Response("nope", { status: 500 })],
      { submitsForApproval: true },
      {
        kind: "failed",
        reason: "publish_failed",
        error: "Couldn't submit this post for approval.",
        captionSaved: true,
      },
    ],
  ];

  it.each(rows)("%s", async (_name, steps, overrides, expected) => {
    const { result } = await run(steps, overrides);
    expect(result).toEqual(expected);
  });
});

describe("scheduleDraft — (e) success maps the publish response onto the card", () => {
  it("200 scheduled (owner / no approval): scheduled at the returned time, caption included", async () => {
    const { result } = await run([json(200, { ok: true }), json(200, { ok: true, status: "scheduled", scheduledFor: SCHEDULED_AT })]);
    expect(result).toEqual({
      kind: "scheduled",
      patch: { caption: "New caption", status: "scheduled", scheduledFor: SCHEDULED_AT },
      message: "Post scheduled.",
      captionSaved: true,
    });
  });

  it("202 pending (member under approval): pending draft keeping the proposed time", async () => {
    const { result } = await run(
      [json(202, { ok: true, status: "draft", approvalState: "pending", scheduledFor: SCHEDULED_AT })],
      { originalCaption: "New caption", submitsForApproval: true },
    );
    expect(result).toEqual({
      kind: "scheduled",
      patch: {
        caption: "New caption",
        status: "draft",
        approvalState: "pending",
        scheduledFor: SCHEDULED_AT,
      },
      message: "Sent for approval",
      captionSaved: false,
    });
  });
});

describe("scheduleDraft — network failures", () => {
  it("throw before the PATCH lands: error, caption NOT saved, publish never attempted", async () => {
    const { result, calls } = await run([new TypeError("Failed to fetch")]);
    expect(calls).toEqual([PATCH_CALL]);
    expect(result).toEqual({
      kind: "failed",
      reason: "network_error",
      error: "Couldn't save your changes.",
      captionSaved: false,
    });
  });

  it("throw on publish after the PATCH landed: error, caption reported saved", async () => {
    const { result, calls } = await run([json(200, { ok: true }), new TypeError("Failed to fetch")]);
    expect(calls).toEqual([PATCH_CALL, PUBLISH_CALL]);
    expect(result).toEqual({
      kind: "failed",
      reason: "network_error",
      error: "Couldn't save your changes.",
      captionSaved: true,
    });
  });

  it("throw on publish when there was no PATCH: caption not reported saved", async () => {
    const { result, calls } = await run([new TypeError("Failed to fetch")], { originalCaption: "New caption" });
    expect(calls).toEqual([PUBLISH_CALL]);
    expect(result).toMatchObject({ kind: "failed", reason: "network_error", captionSaved: false });
  });
});

describe("scheduleDraft — an unreadable publish response is an ERROR, never a success", () => {
  const SAVED_STEP = json(200, { ok: true });
  const rows: Array<[string, () => Response]> = [
    ["2xx with a non-JSON body", () => new Response("<html>gateway</html>", { status: 200 })],
    ["2xx with an empty body", () => new Response(null, { status: 202 })],
    ["2xx with JSON null", () => json(200, null)],
    ["2xx with an unrelated object", () => json(200, { ok: true })],
    ["2xx claiming in_progress (not what a schedule request returns)", () => json(202, { ok: true, status: "in_progress" })],
    ["2xx scheduled but without a time", () => json(200, { ok: true, status: "scheduled" })],
  ];

  it.each(rows)("%s", async (_name, makeResponse) => {
    const { result } = await run([SAVED_STEP, makeResponse()]);
    expect(result).toEqual({
      kind: "failed",
      reason: "unreadable_response",
      error: "Couldn't confirm what happened to this post. Check the Queue before trying again.",
      captionSaved: true,
    });
  });

  it("is distinct from a non-2xx unreadable body, which stays a plain publish failure", async () => {
    const { result } = await run([SAVED_STEP, new Response("<html>bad gateway</html>", { status: 502 })]);
    expect(result).toMatchObject({ kind: "failed", reason: "publish_failed" });
  });
});

describe("scheduleDraft — per-platform captions", () => {
  const SCHEDULED = () => json(200, { ok: true, status: "scheduled", scheduledFor: SCHEDULED_AT });

  it("sends changed per-platform captions with the caption in the PATCH", async () => {
    const { calls } = await run([json(200, { ok: true }), SCHEDULED()], {
      perPlatformOverrides: { x: "Short for X" },
    });
    expect(calls).toEqual([
      {
        method: "PATCH",
        url: "/api/posts/job-1",
        body: { baseCaption: "New caption", perPlatformOverrides: { x: "Short for X" } },
      },
      PUBLISH_CALL,
    ]);
  });

  it("PATCHes when only the per-platform captions changed (caption unchanged)", async () => {
    const { calls } = await run([json(200, { ok: true }), SCHEDULED()], {
      originalCaption: "New caption",
      perPlatformOverrides: { linkedin: "For LinkedIn" },
    });
    expect(calls[0]).toEqual({
      method: "PATCH",
      url: "/api/posts/job-1",
      body: { baseCaption: "New caption", perPlatformOverrides: { linkedin: "For LinkedIn" } },
    });
    expect(calls).toHaveLength(2);
  });

  it("sends null to remove every per-platform caption", async () => {
    const { calls } = await run([json(200, { ok: true }), SCHEDULED()], {
      originalCaption: "New caption",
      perPlatformOverrides: null,
    });
    expect(calls[0].body).toEqual({ baseCaption: "New caption", perPlatformOverrides: null });
  });

  it("leaves the field out when the per-platform captions were not edited", async () => {
    const { calls } = await run([json(200, { ok: true }), SCHEDULED()]);
    expect(calls[0].body).toEqual({ baseCaption: "New caption" });
  });
});
