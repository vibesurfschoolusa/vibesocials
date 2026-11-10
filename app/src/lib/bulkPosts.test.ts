import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BULK_MAX_FILES,
  BULK_TOO_MANY_FILES_MESSAGE,
  BULK_EMPTY_CAPTION_MESSAGE,
  BULK_NOT_UPLOADED_MESSAGE,
  BULK_NO_PLATFORMS_MESSAGE,
  BULK_NO_TIME_MESSAGE,
  BULK_PAST_TIME_MESSAGE,
  BULK_MAYBE_CREATED_MESSAGE,
  BULK_DRAFTS_NOTE,
  BULK_GOOGLE_BUTTON_NOTE,
  BULK_YOUTUBE_PRIVACY_DEFAULT,
  UNREADABLE_BODY,
  type BulkScheduleControls,
  type BulkSendableRow,
  applySchedule,
  captionProgressText,
  classifySendResponse,
  filesThatFit,
  minFirstDay,
  minRowTime,
  moveRow,
  nextWork,
  platformsForRow,
  refreshedFirstDay,
  rowSendBlock,
  rowsToSend,
  allRowsCreated,
  spreadSchedule,
  tomorrowLocalDate,
  youtubePrivacyShown,
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

    it("moves a time that does not exist when the clocks go forward to the next valid time (2027-03-14 in New York)", () => {
      const slots = spreadSchedule({ count: 3, firstDay: "2027-03-13", timeOfDay: "02:30", everyDays: 1 });

      expect(slots).toEqual(["2027-03-13T02:30", "2027-03-14T03:30", "2027-03-15T02:30"]);
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
    uncertain: false,
    ...overrides,
  };
}

// The moment "Schedule all" is pressed in these tests: 2026-11-10 12:00 local.
const pressedAt = () => new Date(2026, 10, 10, 12, 0, 0);

describe("rowsToSend", () => {
  it("skips rows that were already created, and sends rows that were refused before", () => {
    const rows = [
      sendable({ id: "created", postId: "job-1" }),
      sendable({ id: "refused-before" }),
      sendable({ id: "new" }),
    ];

    expect(rowsToSend(rows).map((r) => r.id)).toEqual(["refused-before", "new"]);
  });

  it("leaves out a row whose post may already exist, until the user says to send it again", () => {
    const rows = [sendable({ id: "maybe", uncertain: true }), sendable({ id: "new" })];

    expect(rowsToSend(rows).map((r) => r.id)).toEqual(["new"]);
    expect(rowsToSend([{ ...rows[0], uncertain: false }]).map((r) => r.id)).toEqual(["maybe"]);
  });
});

describe("allRowsCreated", () => {
  it("is true only when there are rows and every one has a post", () => {
    expect(allRowsCreated([])).toBe(false);
    expect(allRowsCreated([sendable({ postId: "a" }), sendable({ postId: null })])).toBe(false);
    expect(allRowsCreated([sendable({ postId: "a" }), sendable({ postId: null, uncertain: true })])).toBe(false);
    expect(allRowsCreated([sendable({ postId: "a" }), sendable({ postId: "b" })])).toBe(true);
  });
});

describe("rowSendBlock", () => {
  it("lets a ready row through for either button", () => {
    expect(rowSendBlock(sendable(), "schedule", pressedAt())).toBeNull();
    expect(rowSendBlock(sendable(), "draft", pressedAt())).toBeNull();
  });

  // POST /api/posts refuses a blank baseCaption ("baseCaption is required"), so
  // the page refuses it first, with a sentence the user can act on.
  it("refuses a row with an empty or blank caption", () => {
    expect(rowSendBlock(sendable({ caption: "" }), "schedule", pressedAt())).toBe(BULK_EMPTY_CAPTION_MESSAGE);
    expect(rowSendBlock(sendable({ caption: "   " }), "draft", pressedAt())).toBe(BULK_EMPTY_CAPTION_MESSAGE);
    expect(BULK_EMPTY_CAPTION_MESSAGE).toBe("Write a caption for this post, then press the button again.");
  });

  it("refuses a row whose file has not uploaded", () => {
    expect(rowSendBlock(sendable({ uploaded: false }), "draft", pressedAt())).toBe(BULK_NOT_UPLOADED_MESSAGE);
  });

  it("refuses a row that no chosen platform takes", () => {
    expect(rowSendBlock(sendable({ platforms: [] }), "draft", pressedAt())).toBe(BULK_NO_PLATFORMS_MESSAGE);
  });

  it("refuses to schedule a row without a date and time, but a draft does not need one", () => {
    expect(rowSendBlock(sendable({ when: "" }), "schedule", pressedAt())).toBe(BULK_NO_TIME_MESSAGE);
    expect(rowSendBlock(sendable({ when: "not a time" }), "schedule", pressedAt())).toBe(BULK_NO_TIME_MESSAGE);
    expect(rowSendBlock(sendable({ when: "" }), "draft", pressedAt())).toBeNull();
  });

  it("refuses to schedule a time less than a minute after the press, and lets a draft through", () => {
    expect(BULK_PAST_TIME_MESSAGE).toBe("Pick a time in the future.");
    expect(rowSendBlock(sendable({ when: "2026-11-10T11:00" }), "schedule", pressedAt())).toBe(BULK_PAST_TIME_MESSAGE);
    expect(rowSendBlock(sendable({ when: "2026-11-10T12:00" }), "schedule", pressedAt())).toBe(BULK_PAST_TIME_MESSAGE);
    expect(rowSendBlock(sendable({ when: "2026-11-10T12:01" }), "schedule", pressedAt())).toBeNull();
    expect(rowSendBlock(sendable({ when: "2026-11-10T11:00" }), "draft", pressedAt())).toBeNull();
  });

  it("checks against the clock it is given, so a page left open past the time refuses it", () => {
    const row = sendable({ when: "2026-11-11T18:00" });

    expect(rowSendBlock(row, "schedule", pressedAt())).toBeNull();
    expect(rowSendBlock(row, "schedule", new Date(2026, 10, 11, 18, 30))).toBe(BULK_PAST_TIME_MESSAGE);
  });
});

describe("classifySendResponse", () => {
  it("keeps the created post's id from a 201", () => {
    expect(
      classifySendResponse({ status: 201, body: { postJob: { id: "job-9" }, message: "Post scheduled." } }, "schedule"),
    ).toEqual({ outcome: "created", postId: "job-9", heldForApproval: false });
  });

  it("notes a post held for approval", () => {
    expect(
      classifySendResponse({ status: 200, body: { postJob: { id: "job-9" }, awaitingApproval: true } }, "schedule"),
    ).toEqual({ outcome: "created", postId: "job-9", heldForApproval: true });
  });

  it("counts a readable success as created even when it names no id, so it is never sent twice", () => {
    expect(classifySendResponse({ status: 200, body: { postJob: null } }, "draft")).toEqual({
      outcome: "created",
      postId: "created",
      heldForApproval: false,
    });
  });

  // The route creates the post before it answers, and has no idempotency key.
  it("is unknown when the request threw (no answer arrived)", () => {
    expect(classifySendResponse({ threw: true }, "schedule")).toEqual({ outcome: "unknown" });
  });

  it.each([500, 502, 504])("is unknown on a %i", (status) => {
    expect(classifySendResponse({ status, body: { error: "Internal error" } }, "schedule")).toEqual({
      outcome: "unknown",
    });
  });

  it("is unknown when the body cannot be read, even on a success status", () => {
    expect(classifySendResponse({ status: 200, body: UNREADABLE_BODY }, "schedule")).toEqual({ outcome: "unknown" });
    expect(classifySendResponse({ status: 500, body: UNREADABLE_BODY }, "draft")).toEqual({ outcome: "unknown" });
  });

  it("is a refusal with the server's sentence on a 400 or a 429", () => {
    expect(classifySendResponse({ status: 400, body: { error: "baseCaption is required" } }, "draft")).toEqual({
      outcome: "refused",
      error: "baseCaption is required",
    });
    expect(
      classifySendResponse(
        { status: 429, body: { error: "Your workspace has reached today's limit of 25 posts.", code: "DAILY_POST_LIMIT" } },
        "schedule",
      ),
    ).toEqual({ outcome: "refused", error: "Your workspace has reached today's limit of 25 posts." });
  });

  it("is still a refusal on a 4xx whose body cannot be read", () => {
    expect(classifySendResponse({ status: 400, body: UNREADABLE_BODY }, "draft")).toEqual({
      outcome: "refused",
      error: "Failed to create post.",
    });
  });

  it("names the sentence an unknown row shows", () => {
    expect(BULK_MAYBE_CREATED_MESSAGE).toBe(
      "This post may have been created. Check the Queue before sending it again.",
    );
  });
});

describe("refreshedFirstDay", () => {
  it("moves the default first day on once the page has been open past midnight", () => {
    expect(refreshedFirstDay({ firstDay: "2026-11-11", setByUser: false }, new Date(2026, 10, 11, 0, 5))).toBe(
      "2026-11-12",
    );
  });

  it("leaves it when it is still tomorrow, or when the user picked it", () => {
    expect(refreshedFirstDay({ firstDay: "2026-11-11", setByUser: false }, new Date(2026, 10, 10, 23, 59))).toBeNull();
    expect(refreshedFirstDay({ firstDay: "2026-11-11", setByUser: true }, new Date(2026, 10, 12, 9, 0))).toBeNull();
  });
});

describe("minimum input values", () => {
  it("gives today as the earliest first day and now plus a minute as the earliest row time", () => {
    const now = new Date(2026, 10, 10, 23, 59, 30);

    expect(minFirstDay(now)).toBe("2026-11-10");
    expect(minRowTime(now)).toBe("2026-11-11T00:01");
  });
});

describe("YouTube privacy", () => {
  it("starts unlisted, as on Create", () => {
    expect(BULK_YOUTUBE_PRIVACY_DEFAULT).toBe("unlisted");
  });

  it("is offered only when YouTube is chosen and at least one row is a video", () => {
    expect(youtubePrivacyShown(["youtube", "x"], ["image/jpeg", "video/mp4"])).toBe(true);
    expect(youtubePrivacyShown(["youtube"], ["image/jpeg"])).toBe(false);
    expect(youtubePrivacyShown(["x"], ["video/mp4"])).toBe(false);
  });
});

describe("notes under the buttons", () => {
  it("says what the buttons do", () => {
    expect(BULK_DRAFTS_NOTE).toBe("Drafts are saved without a time. Set each one's time in the Queue.");
    expect(BULK_GOOGLE_BUTTON_NOTE).toBe(
      "Google posts get your workspace's default button, if one is set in Settings.",
    );
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
