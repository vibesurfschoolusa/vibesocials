import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RESCHEDULE_MAYBE_MOVED_MESSAGE } from "./queue-calendar";
import {
  QUEUE_CANCEL_MAYBE_MESSAGE,
  QUEUE_CANCEL_SERIES_MAYBE_MESSAGE,
  QUEUE_DELETE_MAYBE_MESSAGE,
  REVIEW_LINK_MAYBE_MADE_MESSAGE,
  REVIEW_LINK_MAYBE_OFF_MESSAGE,
  EDIT_COPY_YOUR_TEXT,
  editMovedOnText,
} from "./queue-view";

/**
 * R28 NN2 (publishing L3, pages L1, client-journey L1): Cancel, Delete, the
 * calendar drag and the review link's Replace and Turn off may all have gone
 * through when the answer is lost or a gateway answers 5xx. Each says so,
 * reloads what it can, and never says nothing changed.
 */
const view = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");
const calendar = readFileSync(fileURLToPath(new URL("./queue-calendar.tsx", import.meta.url)), "utf8");

function handler(source: string, start: string): string {
  const at = source.indexOf(start);
  expect(at, start).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf("\n  }", at) + 4);
}

describe("Queue: a lost answer may have gone through", () => {
  it("says what may have happened, and the Queue reloads", () => {
    expect(QUEUE_CANCEL_MAYBE_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so the post may have been cancelled. If your connection dropped, reconnect first. We're reloading the Queue: check it before you cancel again.",
    );
    expect(QUEUE_CANCEL_SERIES_MAYBE_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so the posts may have been cancelled. If your connection dropped, reconnect first. We're reloading the Queue: check it before you cancel again.",
    );
    expect(QUEUE_DELETE_MAYBE_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so the draft may have been deleted. If your connection dropped, reconnect first. We're reloading the Queue: check it before you delete again.",
    );
    expect(RESCHEDULE_MAYBE_MOVED_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so the post may have moved. If your connection dropped, reconnect first. We're reloading the Queue: check its day before you move it again.",
    );
  });

  it("Cancel and Delete use sendActionRequest: offline nothing sent, no answer reloads and closes", () => {
    for (const [name, maybe] of [
      ["const confirmCancel", "request.series ? QUEUE_CANCEL_SERIES_MAYBE_MESSAGE : QUEUE_CANCEL_MAYBE_MESSAGE"],
      ["const confirmDelete", "QUEUE_DELETE_MAYBE_MESSAGE"],
    ]) {
      const body = view.slice(view.indexOf(name), view.indexOf("}, [", view.indexOf(name)));
      expect(body, name).toMatch(/await sendActionRequest\(/);
      expect(body, name).not.toMatch(/fetchOrNoAnswer\(/);
      expect(body, name).toMatch(/answer\.kind === "not_sent"\) \{\s+toast\.error\(CONFIRM_NOTHING_SENT_MESSAGE\);\s+throw new ConfirmFailureShown/);
      expect(body, name).toContain(`if (answer.kind === "no_answer") {\n      void load({ silent: true });\n      toast.error(${maybe});\n      return;`);
    }
  });

  it("the calendar drag: sendActionRequest, and no answer reloads the Queue", () => {
    const drop = handler(calendar, "async function handleDrop");
    expect(drop).toMatch(/await sendActionRequest\(`\/api\/posts\/\$\{job\.id\}`, cardRequest\(job, "PATCH"/);
    expect(drop).not.toMatch(/await fetch\(/);
    expect(drop).toMatch(/answer\.kind === "not_sent"\) \{\s+toast\.error\(CONFIRM_NOTHING_SENT_MESSAGE\);/);
    expect(drop).toMatch(/answer\.kind === "no_answer"\) \{\s+onReload\(\);\s+toast\.error\(RESCHEDULE_MAYBE_MOVED_MESSAGE\);/);
    expect(view.match(/onReload=\{reloadSilently\}/g)).toHaveLength(2);
  });

  it("the review link's Create, Replace and Turn off say what may have happened, and read the link again", () => {
    expect(REVIEW_LINK_MAYBE_MADE_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so a new review link may have been made, which turns any old one off. If your connection dropped, reconnect first. Reload this page and copy the link before you send it.",
    );
    expect(REVIEW_LINK_MAYBE_OFF_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so the review link may have been turned off. If your connection dropped, reconnect first. Reload this page to see.",
    );
    expect(view).toMatch(/unreachableText=\{confirm === "replace" \? REVIEW_LINK_MAYBE_MADE_MESSAGE : REVIEW_LINK_MAYBE_OFF_MESSAGE\}/);
    expect(view).toMatch(/confirmFailureText\(error, REVIEW_LINK_MAYBE_MADE_MESSAGE\)/);
    expect(view.match(/catch \(error\) \{\s+if \(isNoAnswer\(error\)\) void readLink\(\);\s+throw error;/g)).toHaveLength(2);
  });

  it("the Edit dialog's requests go through fetchOrNoAnswer", () => {
    expect(view).toMatch(/pairAwareFetch\(job, \(url, init\) => fetchOrNoAnswer\(url, init\)\)/);
  });

  // Lead review 3: scheduleDraft words a lost answer itself; its catch is an unexpected failure, which may follow a save.
  it("an unexpected failure in Save never says nothing was saved", () => {
    expect(view).not.toContain('toast.error("Couldn\'t save your changes.");');
    expect(view).toMatch(/\} catch \{\s+(\/\/[^\n]*\s+)?toast\.error\(CONFIRM_FAILED_MESSAGE\);\s+setSaving\(false\);/);
  });
});

// R30 publishing L1: a card that started publishing while the page was open
// still showed Scheduled; Cancel, Edit and the calendar drag got a 409, showed
// it and left the stale card (and the Cancel dialog) as they were. Each now
// reloads the list silently and closes, as Publish now and Approve do.
describe("Queue: a stale card's 409 reloads the list", () => {
  it("Cancel: the route's sentence, a silent reload, and the dialog closes", () => {
    const body = view.slice(view.indexOf("const confirmCancel"), view.indexOf("}, [", view.indexOf("const confirmCancel")));
    expect(body).toMatch(
      /if \(!response\.ok\) \{\s+toast\.error\(data\?\.error \?\? "Couldn't cancel this post\."\);\s+if \(shouldRefetchAfterError\(response\.status\)\) \{\s+(\/\/[^\n]*\n\s+)*void load\(\{ silent: true \}\);\s+return;\s+\}\s+throw new ConfirmFailureShown\("CANCEL_FAILED"\);/,
    );
  });

  // Lead review: closing the dialog dropped what was typed. It stays open with
  // the route's sentence, Save is off, and the list reloads behind it.
  it("Edit: the dialog stays open with the route's sentence, Save off, and the list reloads behind it", () => {
    const start = view.indexOf("const errorData = (await response.json()");
    expect(start).toBeGreaterThan(-1);
    const failed = view.slice(start, view.indexOf("const outcome = editOutcome(data);", start));
    expect(failed).toMatch(
      /if \(shouldRefetchAfterError\(response\.status\)\) \{\s+(\/\/[^\n]*\n\s+)*focusAfterPress\(saveRef\.current, \(\) => movedOnRef\.current\);\s+setMovedOn\(editMovedOnText\(response\.status, errorData\?\.error\)\);\s+onStale\(\);\s+return;\s+\}/,
    );
    expect(failed).not.toContain("onClose()");
    expect(view).toMatch(/<Button ref=\{saveRef\} onClick=\{handleSave\} loading=\{saving\} disabled=\{captionOver \|\| movedOn !== null\}>/);
    expect(view).toMatch(/\{movedOn \? \(\s+<Alert ref=\{movedOnRef\} tabIndex=\{-1\} variant="danger" className="outline-none">\s+\{movedOn\}\s+<\/Alert>/);
    expect(EDIT_COPY_YOUR_TEXT).toBe("Copy your text if you want to keep it, then press Cancel.");
  });

  // Lead review: a 404 read "Not found Copy your text...". Each refusal is a
  // sentence, and the copy step always follows a full stop.
  it("Edit: each refusal is worded as a sentence before the copy step", () => {
    expect(editMovedOnText(404, "Not found")).toBe(
      "This post no longer exists. Copy your text if you want to keep it, then press Cancel.",
    );
    expect(
      editMovedOnText(409, "This post has started publishing, so it can't be edited. Check Activity to see how it goes."),
    ).toBe(
      "This post has started publishing, so it can't be edited. Check Activity to see how it goes. Copy your text if you want to keep it, then press Cancel.",
    );
    expect(editMovedOnText(409, "This post can no longer be edited")).toBe(
      "This post can no longer be edited. Copy your text if you want to keep it, then press Cancel.",
    );
    expect(editMovedOnText(409, undefined)).toBe(
      "This post can no longer be edited. Copy your text if you want to keep it, then press Cancel.",
    );
    expect(editMovedOnText(503, "  ")).toBe(
      "This post can no longer be edited. Copy your text if you want to keep it, then press Cancel.",
    );
  });

  it("the calendar drag: the route's sentence and a silent reload", () => {
    const drop = handler(calendar, "async function handleDrop");
    expect(drop).toMatch(
      /toast\.error\(data\?\.error \?\? "Couldn't reschedule this post\."\);\s+(\/\/[^\n]*\n\s+)*if \(shouldRefetchAfterError\(response\.status\)\) onReload\(\);\s+return;/,
    );
  });
});
