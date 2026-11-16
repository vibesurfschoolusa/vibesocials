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
});
