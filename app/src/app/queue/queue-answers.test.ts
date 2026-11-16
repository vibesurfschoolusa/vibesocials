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

// R30 publishing L1, R31 publishing L3-L5 and pages L2: one rule for a post
// action's refusal (queueActions postActionRefusal), on every action: a post
// that moved on (any 409, a 404, a 400 NOT_SCHEDULED) gets the route's
// sentence and a quiet reload; another workspace's answer gets its sentence
// and no reload into that workspace.
describe("Queue: a refused post action, one rule", () => {
  const between = (start: string, end: string) => {
    const at = view.indexOf(start);
    expect(at, start).toBeGreaterThan(-1);
    return view.slice(at, view.indexOf(end, at));
  };

  it("showRefusal says the sentence and reloads only when the rule says so", () => {
    expect(between("const showRefusal = useCallback(", "}, [")).toMatch(
      /\(refusal: PostActionRefusal\) => \{\s+toast\.error\(refusal\.text\);\s+if \(refusal\.reload\) void load\(\{ silent: true \}\);/,
    );
    expect(view).not.toMatch(/shouldRefetchAfterError/);
    expect(calendar).not.toMatch(/shouldRefetchAfterError/);
  });

  it.each([
    ["const confirmCancel", "Couldn't cancel this post.", "CANCEL_FAILED", ""],
    ["const confirmDelete", "Couldn't delete this draft.", "DELETE_FAILED", ""],
    ["const confirmPublish", "Couldn't publish this post.", "PUBLISH_FAILED", ', "Publish"'],
  ])("%s: a post that moved on closes the dialog with the route's sentence; anything else keeps it open", (name, fallback, code, button) => {
    const body = between(name, "}, [");
    const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(body).toMatch(
      new RegExp(
        `if \\(!response\\.ok\\) \\{\\s+const refusal = postActionRefusal\\(response\\.status, data, "${escaped(fallback)}"${escaped(button)}\\);\\s+showRefusal\\(refusal\\);\\s+(\\/\\/[^\\n]*\\n\\s+)*if \\(refusal\\.movedOn\\) return;\\s+throw new ConfirmFailureShown\\("${code}"\\);`,
      ),
    );
  });

  it("Approve and Reject: the same rule", () => {
    expect(between("const handleDecide", "}, [")).toMatch(
      /showRefusal\(\s*postActionRefusal\(\s*response\.status,\s*data,\s*decision === "approve" \? "Couldn't approve this post\." : "Couldn't reject this post\.",\s*"Approve",?\s*\),?\s*\);/,
    );
  });

  // Lead review (R30): closing the dialog dropped what was typed. It stays open
  // with the route's sentence, Save is off, and the list reloads behind it.
  it("Edit, a scheduled post: the dialog stays open with the route's sentence, Save off, and a reload when the rule says so", () => {
    const failed = between("const errorData = (await response.json()", "const outcome = editOutcome(data);");
    expect(failed).toMatch(
      /const refusal = postActionRefusal\(response\.status, errorData, "Couldn't save your changes\."\);\s+if \(refusal\.movedOn\) \{\s+(\/\/[^\n]*\n\s+)*focusAfterPress\(saveRef\.current, \(\) => movedOnRef\.current\);\s+setMovedOn\(editMovedOnText\(refusal\.text\)\);\s+if \(refusal\.reload\) onStale\(\);\s+return;\s+\}\s+toast\.error\(refusal\.text\);/,
    );
    expect(failed).not.toContain("onClose()");
    expect(view).toMatch(/<Button ref=\{saveRef\} onClick=\{handleSave\} loading=\{saving\} disabled=\{captionOver \|\| movedOn !== null\}>/);
    expect(view).toMatch(/\{movedOn \? \(\s+<Alert ref=\{movedOnRef\} tabIndex=\{-1\} variant="danger" className="outline-none">\s+\{movedOn\}\s+<\/Alert>/);
    expect(EDIT_COPY_YOUR_TEXT).toBe("Copy your text if you want to keep it, then press Cancel.");
  });

  // R31 publishing L3: a draft given a time used to reload only on a lost answer.
  it("Edit, a draft given a time: the same, keeping the dialog and what was typed", () => {
    const failed = between('if (result.kind === "failed") {', "toast.success(withPairNote(result.message");
    expect(failed).toMatch(
      /if \(result\.movedOn\) \{\s+(\/\/[^\n]*\n\s+)*focusAfterPress\(saveRef\.current, \(\) => movedOnRef\.current\);\s+setMovedOn\(editMovedOnText\(result\.error\)\);\s+if \(result\.movedOn\.reload\) onStale\(\);\s+setSaving\(false\);\s+return;\s+\}/,
    );
    expect(failed).not.toContain("onClose()");
  });

  it("Edit: each refusal is worded as a sentence before the copy step", () => {
    expect(editMovedOnText("This post no longer exists.")).toBe(
      "This post no longer exists. Copy your text if you want to keep it, then press Cancel.",
    );
    expect(editMovedOnText("This post can no longer be edited")).toBe(
      "This post can no longer be edited. Copy your text if you want to keep it, then press Cancel.",
    );
    expect(editMovedOnText("  ")).toBe(
      "This post can no longer be edited. Copy your text if you want to keep it, then press Cancel.",
    );
  });

  it("the calendar drag: the same rule, reloading through onReload", () => {
    const drop = handler(calendar, "async function handleDrop");
    expect(drop).toMatch(
      /const refusal = postActionRefusal\(response\.status, data, "Couldn't reschedule this post\."\);\s+toast\.error\(refusal\.text\);\s+(\/\/[^\n]*\n\s+)*if \(refusal\.reload\) onReload\(\);\s+return;/,
    );
  });

  // R31 pages L2: every request about a card carries the workspace the Queue was drawn for.
  it("every card request carries the page's workspace id", () => {
    expect(view).not.toMatch(/cardRequest\((?:job|deleteTarget|publishTarget|card), "[A-Z]+"(?:\)|, \{)/);
    expect(view.match(/cardRequest\([^)]*workspaceId/g)?.length).toBeGreaterThanOrEqual(4);
    expect(calendar).toMatch(/cardRequest\(job, "PATCH", workspaceId, \{ scheduledFor: nextIso \}\)/);
    expect(view).toMatch(/scheduleDraft\(\{[\s\S]*?workspaceId,[\s\S]*?\}\)/);
  });
});
