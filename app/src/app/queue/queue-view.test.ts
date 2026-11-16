import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { PostJobDTO } from "@/lib/postsDto";
import { SIGNED_OUT_ERROR } from "@/lib/signedOutMessage";

import {
  cancelRequest,
  coverEditNote,
  coverLabel,
  emptyCaptionMessage,
  isTextPost,
  labelName,
  pairLabel,
  queueListUrl,
  queueLoadErrorText,
  readQueueView,
  saveQueueView,
  seriesLabel,
  sortQueue,
} from "./queue-view";

function job(id: string, overrides: Partial<PostJobDTO> = {}): PostJobDTO {
  return {
    id,
    status: "draft",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    scheduledFor: null,
    caption: id,
    platformCaptions: null,
    results: [],
    media: null,
    mediaCount: 1,
    publish: null,
    createdBy: null,
    approvalState: "none",
    ...overrides,
  };
}

describe("sortQueue", () => {
  it("puts drafts the client asked to change above everything else, oldest request first", () => {
    const sorted = sortQueue([
      job("pending", { approvalState: "pending", createdAt: "2026-10-01T00:00:00.000Z" }),
      job("scheduled", { status: "scheduled", scheduledFor: "2026-11-02T00:00:00.000Z" }),
      job("change-new", { clientChangeRequestedAt: "2026-11-09T00:00:00.000Z", createdAt: "2026-11-05T00:00:00.000Z" }),
      job("plain-draft", { createdAt: "2026-11-08T00:00:00.000Z" }),
      job("change-old", { clientChangeRequestedAt: "2026-11-08T00:00:00.000Z", createdAt: "2026-10-02T00:00:00.000Z" }),
    ]);

    expect(sorted.map((j) => j.id)).toEqual(["change-old", "change-new", "pending", "scheduled", "plain-draft"]);
  });

  it("does not lift a scheduled post that still carries old marks", () => {
    const sorted = sortQueue([
      job("scheduled", { status: "scheduled", scheduledFor: "2026-11-02T00:00:00.000Z", clientChangeRequestedAt: "2026-11-01T00:00:00.000Z" }),
      job("pending", { approvalState: "pending" }),
    ]);
    expect(sorted.map((j) => j.id)).toEqual(["pending", "scheduled"]);
  });
});

describe("seriesLabel", () => {
  it("reads Repeats: 3 of 8 for a post in a series, and nothing otherwise", () => {
    expect(seriesLabel(job("a", { seriesId: "s1", seriesPosition: 3, seriesCount: 8 }))).toBe("Repeats: 3 of 8");
    expect(seriesLabel(job("b", { seriesId: null }))).toBeNull();
    expect(seriesLabel(job("c"))).toBeNull();
  });
});

// V1 fix round 1: a post with a chosen video cover says so.
describe("coverLabel and coverEditNote", () => {
  it("say a post has a custom cover, and nothing for one without", () => {
    expect(coverLabel(job("a", { hasCover: true }))).toBe("Custom cover");
    expect(coverEditNote(job("a", { hasCover: true }))).toBe("Keeps its custom cover.");
    expect(coverLabel(job("b", { hasCover: false }))).toBeNull();
    expect(coverEditNote(job("c"))).toBeNull();
  });
});

describe("cancelRequest", () => {
  it("cancels one post through the single cancel, and the rest of a series through cancel-series", () => {
    expect(cancelRequest(job("a", { seriesId: "s1" }), "one", "ws-1")).toMatchObject({
      url: "/api/posts/a/cancel",
      series: false,
    });
    expect(cancelRequest(job("a", { seriesId: "s1" }), "rest", "ws-1")).toMatchObject({
      url: "/api/posts/a/cancel-series",
      series: true,
    });
    // A post without a series can only be cancelled on its own.
    expect(cancelRequest(job("b"), "rest", "ws-1")).toMatchObject({ url: "/api/posts/b/cancel", series: false });
  });

  // R3-client-journey M1: a Feed and Story card's cancel asks for both halves.
  it("a pair card's cancel asks for both halves; another card's does not", () => {
    expect(JSON.parse(cancelRequest({ ...job("f"), includePair: true }, "one", "ws-1").init.body)).toEqual({
      workspaceId: "ws-1",
      includePair: true,
    });
    expect(JSON.parse(cancelRequest(job("a"), "one", "ws-1").init.body)).toEqual({ workspaceId: "ws-1" });
    expect(cancelRequest(job("a"), "one", "ws-1").init.method).toBe("POST");
  });

  // R31 pages L2: both cancels carry the workspace the Queue was drawn for.
  it("a series cancel carries the page's workspace id too, and never asks for a pair", () => {
    expect(JSON.parse(cancelRequest({ ...job("a", { seriesId: "s1" }), includePair: true }, "rest", "ws-1").init.body)).toEqual({
      workspaceId: "ws-1",
    });
  });
});

describe("a post without a file in the Queue", () => {
  it("is a text post when it has no media and no files", () => {
    expect(isTextPost(job("t", { media: null, mediaCount: 0 }))).toBe(true);
    expect(isTextPost(job("f", { media: { url: "https://blob.example.com/a.jpg", mimeType: "image/jpeg" } }))).toBe(false);
    // A post whose file row is gone still counts its file: it is not a text post.
    expect(isTextPost(job("gone", { media: null, mediaCount: 1 }))).toBe(false);
  });

  it("refuses emptying a text post's caption with its own sentence", () => {
    expect(emptyCaptionMessage(job("t", { media: null, mediaCount: 0 }))).toBe("A post without a photo needs text.");
    expect(emptyCaptionMessage(job("f"))).toBe("Caption can't be empty.");
  });
});

// N3: the Queue remembers List or Calendar per browser.
describe("readQueueView / saveQueueView", () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      data,
    };
  }

  it("reads back a saved view", () => {
    const storage = memoryStorage();
    saveQueueView(() => storage, "calendar");
    expect(readQueueView(() => storage)).toBe("calendar");
    saveQueueView(() => storage, "list");
    expect(readQueueView(() => storage)).toBe("list");
  });

  it("falls back to List for nothing saved, junk, or storage that throws", () => {
    expect(readQueueView(() => memoryStorage())).toBe("list");
    expect(readQueueView(() => memoryStorage({ "vibe.queueView": "grid" }))).toBe("list");
    expect(
      readQueueView(() => {
        throw new Error("SecurityError");
      }),
    ).toBe("list");
    expect(
      readQueueView(() => ({
        getItem: () => {
          throw new Error("blocked");
        },
      })),
    ).toBe("list");
  });

  it("never throws when saving fails", () => {
    expect(() =>
      saveQueueView(
        () => ({
          setItem: () => {
            throw new Error("QuotaExceededError");
          },
        }),
        "calendar",
      ),
    ).not.toThrow();
    expect(() =>
      saveQueueView(() => {
        throw new Error("SecurityError");
      }, "calendar"),
    ).not.toThrow();
  });
});

// F6: each half of a Feed and Story post says it belongs to the other.
describe("pairLabel", () => {
  it("says a Story belongs to the post at its time, and a feed post that it also goes as a Story", () => {
    const at = "2026-11-20T15:00:00.000Z";
    const formatted = new Date(at).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    expect(pairLabel(job("s", { storyOf: { id: "f", scheduledFor: at } }))).toBe(`Story of the post on ${formatted}`);
    expect(pairLabel(job("s", { storyOf: { id: "f", scheduledFor: null } }))).toBe("Story of a post with no time set");
    expect(pairLabel(job("f", { alsoAsStory: true }))).toBe("Also as a Story");
  });

  it("says nothing for a post that is not part of a pair", () => {
    expect(pairLabel(job("a"))).toBeNull();
  });
});

// R3-client-journey M1: a Feed and Story post is one card; the dialogs that
// asked about the other half are gone, and the shared ConfirmDialog stays.
describe("the cancel and delete dialogs", () => {
  const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");

  it("use the shared ConfirmDialog, not a local copy", () => {
    expect(queueSource).not.toContain("QueueConfirmDialog");
  });

  it("no longer look the other half up or offer a checkbox for it", () => {
    expect(queueSource).not.toContain("PairChoice");
    expect(queueSource).not.toContain("lookUpPair");
  });
});

// R5-pages L12: a button's name carries the caption's start, not all of it.
describe("labelName, the caption in a Queue button's name", () => {
  it("keeps a short caption whole", () => {
    expect(labelName("Dawn patrol")).toBe("Dawn patrol");
  });

  it("cuts a long caption to about 40 characters with an ellipsis", () => {
    const caption = "Sunday session at the pier with the whole crew, bring your board and sunscreen";
    const name = labelName(caption);
    expect(name).toBe("Sunday session at the pier with the who…");
    expect(Array.from(name)).toHaveLength(40);
  });

  it("joins lines and spaces into one line, and never cuts an emoji", () => {
    expect(labelName("Waves\n\n  today")).toBe("Waves today");
    const name = labelName(`${"a".repeat(38)}🏄‍♀️ more words after`);
    expect(name).toBe(`${"a".repeat(38)}🏄‍♀️…`);
  });

  it("names a post without a caption", () => {
    expect(labelName(null)).toBe("Untitled post");
    expect(labelName("   ")).toBe("Untitled post");
  });

  it("is what every button's name uses", () => {
    const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");
    const names = queueSource.match(/aria-label=\{`[^`]*`\}/g) ?? [];
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const name of names) expect(name).toContain("${name}");
  });
});

// R16-pages L4: each of the Queue card's three "by" lines wraps a long label
// (a full address on a phone) in ByName, never the bare name.
describe("Queue card by lines", () => {
  it("name the author through ByName", () => {
    const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");
    expect(queueSource.match(/by \{job\.createdBy\.name\}/g) ?? []).toEqual([]);
    expect(queueSource.match(/ · by <ByName name=\{job\.createdBy\.name\} \/>/g) ?? []).toHaveLength(3);
  });
});

// R21 pages L3: Queue's 401 says the shared signed-out sentence, as every other 401 does.
describe("queueLoadErrorText", () => {
  it("a 401 is the shared signed-out sentence", () => {
    expect(queueLoadErrorText(401)).toBe(SIGNED_OUT_ERROR);
  });

  it("any other failure is as before", () => {
    expect(queueLoadErrorText(500)).toBe("Failed to load your queue.");
  });
});

// R25 publishing-flow L2: Cancel, Delete and Publish said nothing when the
// request never left. Cancel and Delete leave it to the dialog (ui/dialog.tsx);
// R27 publishing-flow L3: Publish words a lost answer itself (sendActionRequest).
describe("the Queue's confirm dialogs when Vibe Socials can't be reached", () => {
  const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");

  it("a refusal it already toasted is not shown twice", () => {
    for (const code of ["CANCEL_FAILED", "DELETE_FAILED", "PUBLISH_FAILED", "PUBLISH_NOT_SENT"]) {
      expect(queueSource).toContain(`throw new ConfirmFailureShown("${code}")`);
    }
  });
});

// R27 publishing-flow L3 = pages L10: Approve, Reject, Publish and the Edit
// dialog's save tell "never sent" from "may have gone through".
describe("Queue actions whose answer may be lost", () => {
  const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");
  const body = (start: string, end: string) => queueSource.slice(queueSource.indexOf(start), queueSource.indexOf(end));

  it("send through sendActionRequest, never a plain fetch", () => {
    const decide = body("const handleDecide = useCallback(", "const applyReschedule");
    const publish = body("const confirmPublish = useCallback(", "const publishCopy = publishConfirmCopy");
    const save = body("if (isScheduled || scheduledIso === null) {", "// Schedule a draft");
    for (const part of [decide, publish, save]) {
      expect(part).toContain("sendActionRequest(");
      expect(part).not.toMatch(/(^|[^.\w])fetch\(/);
      expect(part).toMatch(/kind === "not_sent"/);
      expect(part).toMatch(/kind === "no_answer"/);
    }
    expect(decide).toContain("queueMayHaveGoneThroughText(decision)");
    expect(decide).toContain("queueNotSentText(decision)");
    expect(publish).toContain("queueMayHaveGoneThroughText(publishKind)");
    expect(publish).toContain("queueNotSentText(publishKind)");
    expect(save).toContain('queueMayHaveGoneThroughText("edit")');
    expect(save).toContain('queueNotSentText("edit")');
  });

  it("a lost answer reloads the Queue", () => {
    const decide = body("const handleDecide = useCallback(", "const applyReschedule");
    const publish = body("const confirmPublish = useCallback(", "const publishCopy = publishConfirmCopy");
    const save = body("if (isScheduled || scheduledIso === null) {", "// Schedule a draft");
    expect(decide).toMatch(/no_answer"\) \{[^}]*load\(\{ silent: true \}\)/);
    expect(publish).toMatch(/no_answer"\) \{[^}]*load\(\{ silent: true \}\)/);
    expect(save).toMatch(/no_answer"\) \{[^}]*onStale\(\)/);
  });

  it("the dialog's own unreachable sentence for Publish is gone (no copy of the rule)", () => {
    expect(queueSource).not.toContain("PUBLISH_UNREACHABLE_MESSAGE");
  });
});

// R27 publishing-flow L2 = pages L2: each decision has its own busy state.
describe("Approve and Reject", () => {
  const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");

  it("each takes its state from decisionButtonState; Reject is never disabled", () => {
    expect(queueSource).toContain('{...decisionButtonState(deciding, "approve")}');
    expect(queueSource).toContain('{...decisionButtonState(deciding, "reject")}');
    expect(queueSource).not.toContain("disabled={deciding}");
    expect(queueSource).not.toContain("loading={deciding}");
  });
});

// R26 LL3 item 3: a failed Load more says why under the button.
describe("Load more in the Queue", () => {
  const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");

  it("words its failure with the shared sentence and shows it under the button", () => {
    // R29 OO1: an unreadable 5xx came over a working connection, so only a dropped request is "offline".
    expect(queueSource).toMatch(/loadMoreFailureText\(\s*isNoConnection\(error\) \? "offline"/);
    expect(queueSource).toMatch(/loadMoreFailureText\(response\.status\)/);
    expect(queueSource).toMatch(/role="status"[^>]*>\s*\{loadMoreError\}/);
  });
});

// R32 publishing L1: the Queue's reads name the workspace the page was drawn
// for; a refusal says the shared sentence and keeps the cards on the page.
describe("the Queue's reads and the page's workspace", () => {
  const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");

  it("the list and Load more addresses carry the page's id", () => {
    expect(queueListUrl("ws-1")).toBe("/api/posts?status=scheduled%2Cdraft&clientChangesFirst=1&workspaceId=ws-1");
    expect(queueListUrl("ws-1", "c 1")).toBe("/api/posts?status=scheduled%2Cdraft&cursor=c+1&workspaceId=ws-1");
    expect(queueListUrl(null)).toBe("/api/posts?status=scheduled%2Cdraft&clientChangesFirst=1");
  });

  it("the page passes its workspace, and no answer re-points it", () => {
    expect(queueSource).not.toMatch(/setWorkspaceId\(/);
    expect(queueSource).toMatch(/useState<string \| null>\(pageWorkspaceId\)|const workspaceId = pageWorkspaceId/);
    const page = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
    expect(page).toMatch(/workspaceId=\{context\?\.workspace\.id \?\? null\}/);
  });

  it("a refused read says the shared sentence: the first load in place of the list, Load more under its button", () => {
    expect(queueSource.match(/readWorkspaceRefusalText\(response\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(queueSource).toMatch(/if \(refusal\) \{\s*if \(!silent\) setError\(refusal\);/);
    expect(queueSource).toMatch(/if \(refusal\) \{\s*setLoadMoreError\(refusal\);/);
  });

  it("the edit dialog's reads send it too", () => {
    expect(queueSource).toContain("useConnections(workspaceId)");
    expect(queueSource).toContain("fetch(withWorkspaceId(`/api/posts/${encodeURIComponent(job.id)}`, workspaceId))");
  });
});

// R26 LL3 item 1: Publish now and Approve say Create's sentences when publishing couldn't start.
describe("Queue's publish and approve failures", () => {
  const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");

  // R31: through postActionRefusal, which words DISPATCH_FAILED by queueFailureText.
  it("go through postActionRefusal with their button", () => {
    expect(queueSource).toContain('postActionRefusal(response.status, data, "Couldn\'t publish this post.", "Publish")');
    expect(queueSource).toMatch(/postActionRefusal\(\s*response\.status,\s*data,\s*decision === "approve" \? "Couldn't approve this post\." : "Couldn't reject this post\.",\s*"Approve",?\s*\)/);
  });
});

// R27 MM4 review: the Edit dialog's draft-scheduling path follows the same rule.
describe("Edit dialog: scheduling a draft when the answer may be lost", () => {
  const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");
  const draftPath = queueSource.slice(queueSource.indexOf("// Schedule a draft"), queueSource.indexOf("toast.success(withPairNote(result.message"));

  it("offline sends nothing and says so; a lost answer reloads the Queue", () => {
    expect(draftPath).toMatch(/if \(!browserOnline\(\)\) \{\s*toast\.error\(queueNotSentText\(publishNeedsApproval\(job, viewer\) \? "submit" : "schedule"\)\);/);
    expect(draftPath).toMatch(/if \(result\.reason === "unreadable_response" \|\| result\.reason === "no_answer"\) onStale\(\);/);
  });
});

// R27 MM4 item 8: focus never drops to the page body after these presses.
describe("Queue focus after a press", () => {
  const queueSource = readFileSync(fileURLToPath(new URL("./queue-view.tsx", import.meta.url)), "utf8");

  it("a decision watches its pressed button once the answer is in (the card may go, or lose its decision row)", () => {
    expect(queueSource).toMatch(/onClick=\{\(event\) => onDecide\(job, "approve", event\.currentTarget\)\}/);
    expect(queueSource).toMatch(/onClick=\{\(event\) => onDecide\(job, "reject", event\.currentTarget\)\}/);
    const decide = queueSource.slice(queueSource.indexOf("const handleDecide = useCallback("), queueSource.indexOf("const applyReschedule"));
    expect(decide).toMatch(/async \(job: QueueCardPost, decision: "approve" \| "reject", pressed: HTMLElement \| null\)/);
    expect(decide).toMatch(/cardRequest\(job, "POST", workspaceId, \{ decision, reviewedUpdatedAt: job\.updatedAt \}\),\s*\);\s*\/\/[^\n]*\n\s*focusAfterPress\(pressed\);/);
  });

  it("Create link focuses the new link's Copy button", () => {
    expect(queueSource).toMatch(/async function handleCreate\(event\?: React\.MouseEvent<HTMLButtonElement>\) \{\s*const pressed = event\?\.currentTarget \?\? null;/);
    expect(queueSource).toMatch(/await makeLink\(\);\s*\/\/[^\n]*\n\s*focusAfterPress\(pressed, \(\) => copyRef\.current\);/);
    expect(queueSource).toMatch(/<Button ref=\{copyRef\} type="button" variant="outline" onClick=\{onCopy\}>/);
  });
});
