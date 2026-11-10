import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BULK_MAX_FILES,
  BULK_TOO_MANY_FILES_MESSAGE,
  BULK_EMPTY_CAPTION_MESSAGE,
  BULK_NOT_UPLOADED_MESSAGE,
  BULK_NO_PLATFORMS_MESSAGE,
  BULK_NO_TIME_MESSAGE,
  type BulkScheduleControls,
  type BulkSendableRow,
  applySchedule,
  captionProgressText,
  filesThatFit,
  moveRow,
  nextWork,
  platformsForRow,
  rowSendBlock,
  rowsToSend,
  allRowsCreated,
  sendResultFromResponse,
  spreadSchedule,
  tomorrowLocalDate,
} from "./bulkPosts";
import { localDateTimeToUtcIso } from "./scheduling";

describe("BULK_MAX_FILES", () => {
  it("is 20, and the refusal says so", () => {
    expect(BULK_MAX_FILES).toBe(20);
    expect(BULK_TOO_MANY_FILES_MESSAGE).toBe("You can add up to 20 posts at a time.");
  });
});

describe("filesThatFit", () => {
  it("takes every picked file while the batch has room", () => {
    expect(filesThatFit(3, 5)).toEqual({ take: 5, tooMany: false });
  });

  it("takes only what fits and flags the rest", () => {
    expect(filesThatFit(18, 5)).toEqual({ take: 2, tooMany: true });
    expect(filesThatFit(20, 1)).toEqual({ take: 0, tooMany: true });
    expect(filesThatFit(0, 25)).toEqual({ take: 20, tooMany: true });
  });
});

describe("tomorrowLocalDate", () => {
  it("is the next local calendar day, across a month end", () => {
    expect(tomorrowLocalDate(new Date(2026, 10, 30, 23, 30))).toBe("2026-12-01");
    expect(tomorrowLocalDate(new Date(2026, 10, 10, 9, 0))).toBe("2026-11-11");
  });
});

describe("spreadSchedule", () => {
  it("places one a day at the time of day", () => {
    expect(spreadSchedule({ count: 3, firstDay: "2026-11-11", timeOfDay: "18:00", everyDays: 1 })).toEqual([
      "2026-11-11T18:00",
      "2026-11-12T18:00",
      "2026-11-13T18:00",
    ]);
  });

  it("places one every 2 days", () => {
    expect(spreadSchedule({ count: 3, firstDay: "2026-11-11", timeOfDay: "09:30", everyDays: 2 })).toEqual([
      "2026-11-11T09:30",
      "2026-11-13T09:30",
      "2026-11-15T09:30",
    ]);
  });

  it("carries across a month end and a year end", () => {
    expect(spreadSchedule({ count: 3, firstDay: "2026-11-29", timeOfDay: "18:00", everyDays: 1 })).toEqual([
      "2026-11-29T18:00",
      "2026-11-30T18:00",
      "2026-12-01T18:00",
    ]);
    expect(spreadSchedule({ count: 2, firstDay: "2026-12-31", timeOfDay: "18:00", everyDays: 1 })).toEqual([
      "2026-12-31T18:00",
      "2027-01-01T18:00",
    ]);
  });

  it("gives one time for count 1, and twenty for count 20", () => {
    expect(spreadSchedule({ count: 1, firstDay: "2026-11-11", timeOfDay: "18:00", everyDays: 3 })).toEqual([
      "2026-11-11T18:00",
    ]);
    const twenty = spreadSchedule({ count: 20, firstDay: "2026-11-11", timeOfDay: "18:00", everyDays: 1 });
    expect(twenty).toHaveLength(20);
    expect(twenty[0]).toBe("2026-11-11T18:00");
    expect(twenty[19]).toBe("2026-11-30T18:00");
  });

  it("gives nothing for controls that do not make a schedule", () => {
    expect(spreadSchedule({ count: 2, firstDay: "", timeOfDay: "18:00", everyDays: 1 })).toEqual([]);
    expect(spreadSchedule({ count: 2, firstDay: "2026-11-11", timeOfDay: "", everyDays: 1 })).toEqual([]);
    expect(spreadSchedule({ count: 2, firstDay: "2026-11-11", timeOfDay: "18:00", everyDays: 0 })).toEqual([]);
    expect(spreadSchedule({ count: 2, firstDay: "2026-11-11", timeOfDay: "18:00", everyDays: 1.5 })).toEqual([]);
    expect(spreadSchedule({ count: 0, firstDay: "2026-11-11", timeOfDay: "18:00", everyDays: 1 })).toEqual([]);
  });

  describe("across a daylight-saving change", () => {
    let savedTz: string | undefined;
    beforeEach(() => {
      savedTz = process.env.TZ;
      process.env.TZ = "America/New_York";
    });
    afterEach(() => {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    });

    it("keeps the same local time of day when the clocks go back (2026-11-01 in New York)", () => {
      const slots = spreadSchedule({ count: 3, firstDay: "2026-10-31", timeOfDay: "18:00", everyDays: 1 });

      expect(slots).toEqual(["2026-10-31T18:00", "2026-11-01T18:00", "2026-11-02T18:00"]);
      // The same 18:00 local is 22:00 UTC before the change and 23:00 UTC after.
      expect(slots.map((slot) => localDateTimeToUtcIso(slot))).toEqual([
        "2026-10-31T22:00:00.000Z",
        "2026-11-01T23:00:00.000Z",
        "2026-11-02T23:00:00.000Z",
      ]);
    });
  });
});

interface TestRow {
  id: string;
  when: string;
  whenSetByHand: boolean;
}

const CONTROLS: BulkScheduleControls = { firstDay: "2026-11-11", timeOfDay: "18:00", everyDays: 1 };

function autoRows(count: number): TestRow[] {
  return Array.from({ length: count }, (_, i) => ({ id: `r${i + 1}`, when: "", whenSetByHand: false }));
}

describe("applySchedule", () => {
  it("gives every row not set by hand its slot in list order", () => {
    const rows = applySchedule(autoRows(3), CONTROLS);

    expect(rows.map((r) => r.when)).toEqual(["2026-11-11T18:00", "2026-11-12T18:00", "2026-11-13T18:00"]);
  });

  it("keeps a hand-set row's time when the controls change", () => {
    const start = applySchedule(autoRows(3), CONTROLS);
    const handSet = start.map((r) => (r.id === "r2" ? { ...r, when: "2026-12-24T08:15", whenSetByHand: true } : r));

    const changed = applySchedule(handSet, { firstDay: "2026-11-20", timeOfDay: "07:00", everyDays: 2 });

    expect(changed.map((r) => r.when)).toEqual(["2026-11-20T07:00", "2026-12-24T08:15", "2026-11-24T07:00"]);
  });

  it("leaves the rows as they are when the controls do not make a schedule", () => {
    const start = applySchedule(autoRows(2), CONTROLS);

    expect(applySchedule(start, { ...CONTROLS, firstDay: "" })).toEqual(start);
  });

  it("re-spreads only the rows not set by hand after a move", () => {
    const start = applySchedule(autoRows(3), CONTROLS).map((r) =>
      r.id === "r1" ? { ...r, when: "2026-12-24T08:15", whenSetByHand: true } : r,
    );

    // r3 moves up above r2: r3 takes r2's old slot, r1 keeps its own time.
    const moved = applySchedule(moveRow(start, "r3", -1), CONTROLS);

    expect(moved.map((r) => [r.id, r.when])).toEqual([
      ["r1", "2026-12-24T08:15"],
      ["r3", "2026-11-12T18:00"],
      ["r2", "2026-11-13T18:00"],
    ]);
  });

  it("re-spreads only the rows not set by hand after a removal", () => {
    const start = applySchedule(autoRows(4), CONTROLS).map((r) =>
      r.id === "r4" ? { ...r, when: "2026-12-24T08:15", whenSetByHand: true } : r,
    );

    const removed = applySchedule(
      start.filter((r) => r.id !== "r1"),
      CONTROLS,
    );

    expect(removed.map((r) => [r.id, r.when])).toEqual([
      ["r2", "2026-11-11T18:00"],
      ["r3", "2026-11-12T18:00"],
      ["r4", "2026-12-24T08:15"],
    ]);
  });
});

describe("moveRow", () => {
  it("moves a row up or down by one", () => {
    const rows = autoRows(3);

    expect(moveRow(rows, "r2", -1).map((r) => r.id)).toEqual(["r2", "r1", "r3"]);
    expect(moveRow(rows, "r2", 1).map((r) => r.id)).toEqual(["r1", "r3", "r2"]);
  });

  it("leaves the list unchanged at either end or for an unknown row", () => {
    const rows = autoRows(3);

    expect(moveRow(rows, "r1", -1)).toEqual(rows);
    expect(moveRow(rows, "r3", 1)).toEqual(rows);
    expect(moveRow(rows, "nope", 1)).toEqual(rows);
  });
});

describe("platformsForRow", () => {
  it("sends a photo to every chosen platform but YouTube, and says it skips YouTube", () => {
    expect(platformsForRow(["youtube", "instagram", "x"], "image/jpeg")).toEqual({
      platforms: ["instagram", "x"],
      skipped: ["youtube"],
    });
  });

  it("keeps YouTube for a video", () => {
    expect(platformsForRow(["youtube", "instagram"], "video/mp4")).toEqual({
      platforms: ["youtube", "instagram"],
      skipped: [],
    });
  });

  it("never includes TikTok, not even for a video, and does not list it as skipped", () => {
    expect(platformsForRow(["tiktok", "youtube"], "video/mp4")).toEqual({
      platforms: ["youtube"],
      skipped: [],
    });
    expect(platformsForRow(["tiktok"], "image/png")).toEqual({ platforms: [], skipped: [] });
  });

  it("skips a format a platform refuses (LinkedIn and WebP)", () => {
    expect(platformsForRow(["linkedin", "x"], "image/webp")).toEqual({
      platforms: ["x"],
      skipped: ["linkedin"],
    });
  });
});

function sendable(overrides: Partial<BulkSendableRow> = {}): BulkSendableRow {
  return {
    id: "r1",
    uploaded: true,
    caption: "Fresh bread today.",
    platforms: ["instagram"],
    when: "2026-11-11T18:00",
    postId: null,
    ...overrides,
  };
}

describe("rowsToSend", () => {
  it("skips rows that were already created, and sends rows that failed before", () => {
    const rows = [
      sendable({ id: "created", postId: "job-1" }),
      sendable({ id: "failed-before" }),
      sendable({ id: "new" }),
    ];

    expect(rowsToSend(rows).map((r) => r.id)).toEqual(["failed-before", "new"]);
  });
});

describe("allRowsCreated", () => {
  it("is true only when there are rows and every one has a post", () => {
    expect(allRowsCreated([])).toBe(false);
    expect(allRowsCreated([sendable({ postId: "a" }), sendable({ postId: null })])).toBe(false);
    expect(allRowsCreated([sendable({ postId: "a" }), sendable({ postId: "b" })])).toBe(true);
  });
});

describe("rowSendBlock", () => {
  it("lets a ready row through for either button", () => {
    expect(rowSendBlock(sendable(), "schedule")).toBeNull();
    expect(rowSendBlock(sendable(), "draft")).toBeNull();
  });

  // POST /api/posts refuses a blank baseCaption ("baseCaption is required"), so
  // the page refuses it first, with a sentence the user can act on.
  it("refuses a row with an empty or blank caption", () => {
    expect(rowSendBlock(sendable({ caption: "" }), "schedule")).toBe(BULK_EMPTY_CAPTION_MESSAGE);
    expect(rowSendBlock(sendable({ caption: "   " }), "draft")).toBe(BULK_EMPTY_CAPTION_MESSAGE);
    expect(BULK_EMPTY_CAPTION_MESSAGE).toBe("Write a caption for this post, then press the button again.");
  });

  it("refuses a row whose file has not uploaded", () => {
    expect(rowSendBlock(sendable({ uploaded: false }), "draft")).toBe(BULK_NOT_UPLOADED_MESSAGE);
  });

  it("refuses a row that no chosen platform takes", () => {
    expect(rowSendBlock(sendable({ platforms: [] }), "draft")).toBe(BULK_NO_PLATFORMS_MESSAGE);
  });

  it("refuses to schedule a row without a date and time, but a draft does not need one", () => {
    expect(rowSendBlock(sendable({ when: "" }), "schedule")).toBe(BULK_NO_TIME_MESSAGE);
    expect(rowSendBlock(sendable({ when: "" }), "draft")).toBeNull();
  });
});

describe("sendResultFromResponse", () => {
  it("keeps the created post's id", () => {
    expect(
      sendResultFromResponse({ ok: true, body: { postJob: { id: "job-9" }, message: "Post scheduled." }, mode: "schedule" }),
    ).toEqual({ created: true, postId: "job-9", heldForApproval: false });
  });

  it("notes a post held for approval", () => {
    expect(
      sendResultFromResponse({ ok: true, body: { postJob: { id: "job-9" }, awaitingApproval: true }, mode: "schedule" }),
    ).toEqual({ created: true, postId: "job-9", heldForApproval: true });
  });

  it("counts a created post as created even when the response names no id, so it is never sent twice", () => {
    expect(sendResultFromResponse({ ok: true, body: { postJob: null }, mode: "draft" })).toEqual({
      created: true,
      postId: "created",
      heldForApproval: false,
    });
  });

  it("keeps the server's sentence when it refuses", () => {
    expect(
      sendResultFromResponse({
        ok: false,
        body: { error: "Your workspace has reached today's limit of 25 posts.", code: "DAILY_POST_LIMIT" },
        mode: "schedule",
      }),
    ).toEqual({ created: false, error: "Your workspace has reached today's limit of 25 posts." });
    expect(sendResultFromResponse({ ok: false, body: null, mode: "draft" })).toEqual({
      created: false,
      error: "Failed to create post.",
    });
  });
});

interface WorkRow {
  id: string;
  upload: "queued" | "working" | "done" | "failed";
  caption: "waiting" | "writing" | "done" | "failed";
}

describe("nextWork", () => {
  it("finishes each row (upload, then caption) before starting the next", () => {
    const rows: WorkRow[] = [
      { id: "a", upload: "done", caption: "waiting" },
      { id: "b", upload: "queued", caption: "waiting" },
    ];

    expect(nextWork(rows)).toEqual({ id: "a", step: "caption" });
    expect(nextWork([{ ...rows[0], caption: "done" }, rows[1]])).toEqual({ id: "b", step: "upload" });
  });

  it("passes over a failed upload and finished rows", () => {
    const rows: WorkRow[] = [
      { id: "a", upload: "failed", caption: "waiting" },
      { id: "b", upload: "done", caption: "failed" },
      { id: "c", upload: "done", caption: "done" },
    ];

    expect(nextWork(rows)).toBeNull();
  });

  it("waits while anything is in progress, so only one request runs at a time", () => {
    const rows: WorkRow[] = [
      { id: "a", upload: "done", caption: "writing" },
      { id: "b", upload: "queued", caption: "waiting" },
    ];

    expect(nextWork(rows)).toBeNull();
  });
});

describe("captionProgressText", () => {
  it("counts finished captions out of the rows that will get one", () => {
    const rows: WorkRow[] = [
      { id: "a", upload: "done", caption: "done" },
      { id: "b", upload: "done", caption: "failed" },
      { id: "c", upload: "done", caption: "done" },
      { id: "d", upload: "done", caption: "writing" },
      { id: "e", upload: "queued", caption: "waiting" },
    ];

    expect(captionProgressText(rows)).toBe("Writing captions, 3 of 5");
  });

  it("leaves out rows whose upload failed", () => {
    const rows: WorkRow[] = [
      { id: "a", upload: "failed", caption: "waiting" },
      { id: "b", upload: "done", caption: "writing" },
    ];

    expect(captionProgressText(rows)).toBe("Writing captions, 0 of 1");
  });

  it("says nothing once no caption is waiting", () => {
    expect(captionProgressText([{ id: "a", upload: "done", caption: "done" }])).toBeNull();
    expect(captionProgressText([])).toBeNull();
  });
});
