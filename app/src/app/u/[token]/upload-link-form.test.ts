import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BlobAccessError, BlobFileTooLargeError, BlobServiceRateLimited, BlobStoreSuspendedError, BlobUnknownError } from "@vercel/blob";

import { NoAnswerError } from "@/lib/requestNoAnswer";
import { UPLOAD_LINK_IP_LIMIT_MESSAGE, UPLOAD_LINK_IP_LIMIT_REASON } from "@/lib/uploadLink";

import { CLIENT_FILE_MAYBE_ARRIVED_MESSAGE, ClientFileError, sendClientFile, type ClientFileFailure } from "./send-file";
import {
  UploadLinkForm,
  UploadSummary,
  failureOf,
  filesToSend,
  pressWatchTarget,
  retryOffer,
  type SummaryFailure,
} from "./upload-link-form";

const network: ClientFileFailure = {
  kind: "network",
  message: "The upload didn't finish. Check your connection and try again.",
};
const linkOff: ClientFileFailure = { kind: "refused", message: "This link is no longer active. Ask for a new one." };
const full: ClientFileFailure = { kind: "refused", message: "This workspace's storage is full. Ask them to make room." };

function render(sent: number, failures: (ClientFileFailure & { name?: string })[], total = sent + failures.length): string {
  const named: SummaryFailure[] = failures.map((failure, at) => ({ name: `file-${at + 1}.jpg`, ...failure }));
  return renderToStaticMarkup(createElement(UploadSummary, { sentCount: sent, failures: named, total }));
}

describe("UploadSummary, after the files were sent", () => {
  it("thanks the client as a status when every file arrived", () => {
    const html = render(2, []);
    expect(html).toContain('role="status"');
    expect(html).toContain("2 files arrived. Thank you.");
  });

  it("says how many arrived as a status when some did not", () => {
    const html = render(2, [network]);
    expect(html).toContain('role="status"');
    expect(html).toContain("2 of 3 files arrived. The others are marked below.");
  });

  // R5-pages L9: when nothing arrived the page said nothing at all.
  it("network failures only: an alert with the connection advice", () => {
    const html = render(0, [network, network, network]);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Nothing was sent");
    expect(html).toContain(
      "None of the 3 files arrived. The reason is under each file. Check your connection, then try again with the button below.",
    );
  });

  it("names one file as the file", () => {
    expect(render(0, [network])).toContain(
      "The file didn&#x27;t arrive. The reason is under it. Check your connection, then try again with the button below.",
    );
  });

  // Decided by the kind: a refused file whose sentence happens to mention the
  // connection is still not blamed on it.
  it("refused only: no connection advice", () => {
    const odd: ClientFileFailure = { kind: "refused", message: "Check your connection settings in the link." };
    const html = render(0, [linkOff, linkOff]);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("connection");
    expect(render(0, [odd])).not.toContain("then try again with the button below");
  });

  // R49 client-journey L1: a one-file sentence after "None of the 3 files"
  // read as one photo to fix. With more than one failure the summary points
  // at each file, whose row keeps its own sentence; one file keeps its reason.
  describe("several files refused for the same reason", () => {
    const shrink: ClientFileFailure = {
      kind: "file",
      message: "We couldn't make this photo smaller. Save it as a smaller JPEG, then press Send more and choose it again.",
    };

    it("three failed shrinks: the summary never speaks of one photo", () => {
      const html = render(0, [shrink, shrink, shrink]);
      expect(html).toContain("None of the files were sent. See the reason under each file.");
      expect(html).not.toContain("this photo");
      expect(html).not.toContain("choose it again");
    });

    it("three of the server's link-off sentence: still reads right", () => {
      const html = render(0, [linkOff, linkOff, linkOff]);
      expect(html).toContain("None of the files were sent. See the reason under each file.");
      expect(html).not.toContain("connection");
    });

    it("one failed shrink: its own reason, as before", () => {
      expect(render(0, [shrink])).toContain(
        "The file wasn&#x27;t sent. We couldn&#x27;t make this photo smaller. Save it as a smaller JPEG, then press Send more and choose it again.",
      );
    });
  });

  it("gives one refused file's reason", () => {
    expect(render(0, [full])).toContain("The file wasn&#x27;t sent. This workspace&#x27;s storage is full.");
  });

  it("refused with different reasons, or network and refused mixed: points at each file's reason", () => {
    for (const failures of [[linkOff, full], [full, network]]) {
      const html = render(0, failures);
      expect(html).toContain("None of the files were sent. See the reason under each file.");
      expect(html).not.toContain("connection");
    }
  });
});

describe("failureOf, what a failed file says", () => {
  it("keeps the kind and sentence send-file gave", () => {
    expect(failureOf(new ClientFileError("refused", linkOff.message))).toEqual(linkOff);
    expect(failureOf(new ClientFileError("network", network.message))).toEqual(network);
  });

  // Lead review 3 (R28 NN2): not a lost answer (send-file.ts words those), and it may have arrived.
  // R29 client-journey L1: so it is a "maybe", never one the summary says didn't arrive.
  it("treats anything else as a file that may have arrived, in plain words", () => {
    expect(failureOf(new TypeError("Failed to fetch"))).toEqual({
      kind: "maybe",
      message: "Something went wrong while sending this file. It may have arrived: if you send it again, it may arrive twice.",
    });
  });
});

// R29 client-journey L1 = pages L1: a file whose last step's answer was lost
// may have arrived. The summary never says "Nothing was sent" for it, names it,
// and the retry button leaves it out (or warns when only such files are left).
describe("UploadSummary: files that may have arrived", () => {
  const maybe: ClientFileFailure = { kind: "maybe", message: CLIENT_FILE_MAYBE_ARRIVED_MESSAGE };

  it("all sent: no maybe sentence", () => {
    const html = render(2, []);
    expect(html).toContain("2 files arrived. Thank you.");
    expect(html).not.toContain("may have arrived");
  });

  it("one failed before the upload: not sent, tried again", () => {
    const html = render(0, [network]);
    expect(html).toContain("Nothing was sent");
    expect(html).not.toContain("may have arrived");
  });

  it("one maybe: not 'Nothing was sent'; names the file and warns about a second copy", () => {
    const html = render(0, [{ ...maybe, name: "beach.jpg" }]);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Nothing was sent");
    expect(html).not.toContain("didn&#x27;t arrive");
    expect(html).toContain("The file may have arrived");
    expect(html).toContain("beach.jpg may have arrived");
    expect(html).toContain("may arrive twice");
  });

  it("maybe and not sent, nothing confirmed: says which may have arrived and which didn't", () => {
    const html = render(0, [{ ...maybe, name: "a.jpg" }, { ...network, name: "b.jpg" }]);
    expect(html).not.toContain("Nothing was sent");
    expect(html).toContain("a.jpg may have arrived");
    expect(html).toContain("b.jpg didn&#x27;t arrive");
    expect(html).toContain("The button below tries only b.jpg again.");
  });

  // R47 client-journey L1: the button never sends a file refused for itself, so the sentence doesn't say it does.
  it("maybe beside a file refused for itself: the button isn't said to try the refused one", () => {
    const refusedFile: ClientFileFailure = { kind: "file", message: "We couldn't tell what kind of file this is." };
    const html = render(0, [{ ...maybe, name: "a.jpg" }, { ...refusedFile, name: "IMG_0042" }]);
    expect(html).toContain("IMG_0042 didn&#x27;t arrive");
    expect(html).not.toContain("The button below tries only");
  });

  it("mixed with sent files: a status naming the file that may have arrived", () => {
    const html = render(2, [{ ...maybe, name: "a.jpg" }, { ...network, name: "b.jpg" }], 4);
    expect(html).toMatch(/<div role="alert" class="empty:sr-only"><\/div><div role="status"/);
    expect(html).toContain("2 of 4 files arrived.");
    expect(html).toContain("a.jpg may have arrived");
    expect(html).toContain("b.jpg didn&#x27;t arrive");
  });

  it("offline at the press (the token step): not sent, with the connection advice", () => {
    const html = render(0, [network, network]);
    expect(html).toContain("Nothing was sent");
    expect(html).toContain("Check your connection, then try again with the button below.");
  });
});

describe("filesToSend and retryOffer: the retry leaves out files that may have arrived", () => {
  const item = (key: string, status: "waiting" | "sent" | "failed") => ({ key, status });

  it("first press: every file", () => {
    expect(filesToSend([item("a", "waiting"), item("b", "waiting")], {})).toEqual(["a", "b"]);
    expect(retryOffer([item("a", "waiting")], {})).toBeNull();
  });

  it("all sent: nothing to retry", () => {
    expect(filesToSend([item("a", "sent")], {})).toEqual([]);
    expect(retryOffer([item("a", "sent")], {})).toBeNull();
  });

  it("one not sent: tried again, with the usual button", () => {
    expect(filesToSend([item("a", "sent"), item("b", "failed")], { b: "network" })).toEqual(["b"]);
    expect(retryOffer([item("a", "sent"), item("b", "failed")], { b: "network" })).toEqual({
      label: "Try the file that didn't send",
      warning: null,
    });
  });

  it("mixed: the maybe file is left out", () => {
    const files = [item("a", "failed"), item("b", "failed"), item("c", "failed")];
    const kinds = { a: "maybe", b: "network", c: "refused" } as const;
    expect(filesToSend(files, kinds)).toEqual(["b", "c"]);
    expect(retryOffer(files, kinds)).toEqual({ label: "Try the 2 files that didn't send", warning: null });
  });

  // R47 client-journey L1: a file refused for itself (its type, a HEIC that
  // won't convert) is refused again as it is, so no button offers it.
  it("a file refused for itself: no retry offer for it", () => {
    expect(retryOffer([item("a", "failed")], { a: "file" })).toBeNull();
    expect(filesToSend([item("a", "failed")], { a: "file" })).toEqual([]);
  });

  it("a network failure is still offered for retry", () => {
    expect(retryOffer([item("a", "failed")], { a: "network" })).toEqual({
      label: "Try the file that didn't send",
      warning: null,
    });
  });

  it("one refused file plus one network failure: retry for the network one only", () => {
    const files = [item("a", "failed"), item("b", "failed")];
    const kinds = { a: "file", b: "network" } as const;
    expect(retryOffer(files, kinds)).toEqual({ label: "Try the file that didn't send", warning: null });
    expect(filesToSend(files, kinds)).toEqual(["b"]);
  });

  it("a refused file beside a maybe file: the warning button sends only the maybe one", () => {
    const files = [item("a", "failed"), item("b", "failed")];
    const kinds = { a: "file", b: "maybe" } as const;
    expect(retryOffer(files, kinds)).toEqual({
      label: "Send the file again anyway",
      warning: "It may already have arrived: sending it again may make a second copy.",
    });
    expect(filesToSend(files, kinds)).toEqual(["b"]);
  });

  it("only maybe files left: sent again only on a button that warns first", () => {
    expect(filesToSend([item("a", "sent"), item("b", "failed")], { b: "maybe" })).toEqual(["b"]);
    expect(retryOffer([item("b", "failed")], { b: "maybe" })).toEqual({
      label: "Send the file again anyway",
      warning: "It may already have arrived: sending it again may make a second copy.",
    });
    expect(retryOffer([item("b", "failed"), item("c", "failed")], { b: "maybe", c: "maybe" })).toEqual({
      label: "Send the 2 files again anyway",
      warning: "They may already have arrived: sending them again may make second copies.",
    });
  });
});

// R29 pages L2: Enter in the name field submits with Send as the submitter;
// the field is disabled at once and nothing watched it, so the page-wide
// keeper moved focus to Terms. The press watch covers the focused field.
describe("pressWatchTarget: one watch for the press", () => {
  const send = { id: "send" } as unknown as HTMLElement;
  const field = { id: "name" } as unknown as HTMLElement;
  const retry = { id: "retry" } as unknown as HTMLElement;
  const outside = { id: "terms" } as unknown as HTMLElement;
  const form = { contains: (node: unknown) => node === send || node === field || node === retry };

  it("Enter in a field: the field", () => {
    expect(pressWatchTarget(field, send, form, send)).toBe(field);
  });

  it("Send pressed itself: none (the end-of-send watch covers it)", () => {
    expect(pressWatchTarget(send, send, form, send)).toBeNull();
  });

  it("the retry button: the retry button, focused or not (Safari does not focus a clicked button)", () => {
    expect(pressWatchTarget(retry, retry, form, send)).toBe(retry);
    expect(pressWatchTarget(null, retry, form, send)).toBe(retry);
    expect(pressWatchTarget(outside, retry, form, send)).toBe(retry);
  });
});

describe("UploadLinkForm: the press's watch starts before sending", () => {
  it("registers the watch from the focused field before setPhase(\"sending\")", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./upload-link-form.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(
      /const watched = pressWatchTarget\(document\.activeElement, submitter, event\.currentTarget, sendRef\.current\);\s+const stopPressWatch = watched \? focusAfterPress\(watched, \(\) => sendRef\.current\) : \(\) => \{\};\s+setPhase\("sending"\);/,
    );
  });
});

// R29 client-journey L5: the dropped-files note appeared already filled.
describe("UploadLinkForm: the dropped-files note", () => {
  it("is on the page from the first render, empty and visually hidden", () => {
    const html = renderToStaticMarkup(createElement(UploadLinkForm, { token: "t" }));
    expect(html).toMatch(/<p role="status" class="empty:sr-only text-sm text-muted-foreground"><\/p>/);
  });
});

// R27 MM3 (pages L5): the summary appeared already filled, which a screen
// reader may not announce, and Send was replaced under the focus. Both live
// regions are on the page from the first render; when sending ends, focus goes
// to the summary (lib/focusAfter).
describe("UploadSummary before anything was sent", () => {
  it("renders both live regions, empty", () => {
    const html = render(0, [], 0);
    expect(html).toMatch(/<div role="alert" class="empty:sr-only"><\/div>/);
    expect(html).toMatch(/<div role="status" class="empty:sr-only"><\/div>/);
  });

  it("puts each result in its own region", () => {
    expect(render(2, [])).toMatch(/<div role="alert" class="empty:sr-only"><\/div><div role="status" class="empty:sr-only">.*2 files arrived/);
    expect(render(0, [network])).toMatch(/<div role="alert" class="empty:sr-only">.*Nothing was sent.*<\/div><div role="status" class="empty:sr-only"><\/div>/);
  });

  it("the form renders the summary from the first render and moves focus to it when sending ends", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./upload-link-form.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/phase === "done" \? \(\s+<UploadSummary/);
    expect(source).toMatch(/<div ref=\{summaryRef\} tabIndex=\{-1\}[^>]*>\s+<UploadSummary/);
    expect(source).toMatch(/focusAfterPress\(watched, \(\) => sendRef\.current\)/);
    expect(source).toMatch(/focusAfterPress\(sendRef\.current, \(\) => summaryRef\.current\);\s+setPhase\("done"\);/);
  });
});

// R27 MM3 lead review: the press-time watch and the end-of-send watch both
// watched Send, so the first could land focus on its fallback before the
// summary. The press-time one is only for a submitter other than Send (the
// retry button). "Send more" (already on main) replaced itself under the
// focus: it hands focus to the form's first field.
describe("UploadLinkForm: one focus watch per change", () => {
  it("skips the press-time watch when Send itself was pressed", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./upload-link-form.tsx", import.meta.url)), "utf8");
    // R29 pages L2: pressWatchTarget gives none for Send itself (tested above).
    expect(source).toMatch(/const submitter = \(event\.nativeEvent as SubmitEvent\)\.submitter;\s+const watched = pressWatchTarget\(/);
    // Lead review: a fast failure ends sending before the press-time watch runs; it is stopped first.
    expect(source).toMatch(/stopPressWatch\(\);\s+(\/\/[^\n]*\n\s+)*focusAfterPress\(sendRef\.current, \(\) => summaryRef\.current\);\s+setPhase\("done"\);/);
  });

  it("Send more hands focus to the name field", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./upload-link-form.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/function startOver\(pressed: HTMLElement \| null\) \{\s+focusAfterPress\(pressed, \(\) => nameRef\.current\);/);
    expect(source).toMatch(/onClick=\{\(event\) => startOver\(event\.currentTarget\)\}/);
    expect(source).toMatch(/<Input\s+ref=\{nameRef\}\s+id="upload-link-name"/);
  });
});

// R30 client-journey L4: Send more kept the old "left out" note over the empty form.
describe("UploadLinkForm: Send more", () => {
  it("clears the left-out note with the files", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./upload-link-form.tsx", import.meta.url)), "utf8");
    const body = source.slice(source.indexOf("function startOver("), source.indexOf('setPhase("picking");', source.indexOf("function startOver(")));
    expect(body).toContain("setFiles([]);");
    expect(body).toContain("setDropNote(null);");
  });
});

// R53 pages-a L1: each row and the summary tell our server's failure from the
// client's connection, from the failures sendClientFile really throws.
describe("UploadSummary and the rows: our side or the connection", () => {
  const CONNECTION_ROW = "The upload didn't finish. Check your connection and try again.";
  const OUR_SIDE_ROW = "The upload didn't finish: something went wrong on our side. Try again in a minute.";
  const CONNECTION_SUMMARY = "Check your connection, then try again with the button below.";
  const OUR_SIDE_SUMMARY = "Something went wrong on our side. Try again in a few minutes with the button below.";
  const STORAGE_ROW = "File storage didn't take the upload. Try again in a few minutes.";

  const html502 = () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const empty500 = () => new Response("", { status: 500 });

  /** The failure a file's token request ends in, as the form keeps it. */
  async function failed(answer: () => Promise<Response>, put = vi.fn()): Promise<ClientFileFailure> {
    const deps = { prepare: async (file: File) => file, put, fetch: vi.fn(answer) };
    const file = new File(["abc"], "a.jpg", { type: "image/jpeg" });
    const error = await sendClientFile({ token: "T".repeat(43), file, senderName: "", note: "", onProgress: () => {} }, deps).catch(
      (caught: unknown) => caught,
    );
    return failureOf(error);
  }
  const threw = () => Promise.reject(new NoAnswerError(new TypeError("Failed to fetch")));
  const escaped = (text: string) => text.replace(/'/g, "&#x27;");

  it("a fetch that threw: the connection, in the row and the summary", async () => {
    const failure = await failed(threw);
    expect(failure).toMatchObject({ kind: "network", message: CONNECTION_ROW });
    expect(render(0, [failure])).toContain(`The file didn&#x27;t arrive. The reason is under it. ${CONNECTION_SUMMARY}`);
  });

  it("an HTML 502: our side, in the row and the summary", async () => {
    const failure = await failed(async () => html502());
    expect(failure).toMatchObject({ kind: "network", message: OUR_SIDE_ROW });
    const html = render(0, [failure]);
    expect(html).toContain(`The file didn&#x27;t arrive. The reason is under it. ${OUR_SIDE_SUMMARY}`);
    expect(html).not.toContain("connection");
  });

  it("an empty 500: our side, in the row and the summary", async () => {
    const failure = await failed(async () => empty500());
    expect(failure).toMatchObject({ kind: "network", message: OUR_SIDE_ROW });
    expect(render(0, [failure])).toContain(OUR_SIDE_SUMMARY);
  });

  it("a JSON 5xx with its own text: that text, in the row and the summary", async () => {
    const failure = await failed(async () => json(503, { error: "Uploads are paused for a minute." }));
    expect(failure).toEqual({ kind: "refused", message: "Uploads are paused for a minute." });
    expect(render(0, [failure])).toContain("The file wasn&#x27;t sent. Uploads are paused for a minute.");
  });

  it("a 429: unchanged, in the row and the summary", async () => {
    const failure = await failed(async () => json(429, { error: UPLOAD_LINK_IP_LIMIT_MESSAGE }));
    const message = `${UPLOAD_LINK_IP_LIMIT_REASON} Try the files that didn't send again later.`;
    expect(failure).toEqual({ kind: "refused", message });
    expect(render(0, [failure])).toContain(`The file wasn&#x27;t sent. ${escaped(message)}`);
  });

  it("3 files that all failed on our side: our side", async () => {
    const failures = [await failed(async () => html502()), await failed(async () => empty500()), await failed(async () => html502())];
    const html = render(0, failures);
    expect(html).toContain(`None of the 3 files arrived. The reason is under each file. ${OUR_SIDE_SUMMARY}`);
    expect(html).not.toContain("connection");
  });

  // R53 pages-a L2: storage itself refused the upload.
  const tokenIssued = async () => json(200, { clientToken: "ct", pathname: "ul/link-1/a.jpg" });
  const storageRefused = (error: Error) => failed(tokenIssued, vi.fn().mockRejectedValue(error));

  it("storage refusals only: the storage sentence in each row, our side in the summary", async () => {
    const failures = [
      await storageRefused(new BlobStoreSuspendedError()),
      await storageRefused(new BlobAccessError()),
      await storageRefused(new BlobUnknownError()),
    ];
    expect(failures.map((failure) => failure.message)).toEqual([STORAGE_ROW, STORAGE_ROW, STORAGE_ROW]);
    const html = render(0, failures);
    expect(html).toContain(`None of the 3 files arrived. The reason is under each file. ${OUR_SIDE_SUMMARY}`);
    expect(html).not.toContain("connection");
  });

  it("a rate limit from storage: the storage sentence", async () => {
    const failure = await storageRefused(new BlobServiceRateLimited(30));
    expect(failure).toMatchObject({ kind: "network", message: STORAGE_ROW });
    expect(render(0, [failure])).toContain(OUR_SIDE_SUMMARY);
  });

  it("too large from storage: the size sentence, no try again", async () => {
    const failure = await storageRefused(new BlobFileTooLargeError("max 512 MB"));
    expect(failure).toEqual({ kind: "file", message: "File is too large (max 512 MB)." });
    const html = render(0, [failure]);
    expect(html).toContain("The file wasn&#x27;t sent. File is too large (max 512 MB).");
    expect(html).not.toMatch(/[Tt]ry again/);
  });

  it("a storage refusal with a dropped upload: the connection wording", async () => {
    const failures = [await storageRefused(new BlobStoreSuspendedError()), await storageRefused(new TypeError("Failed to fetch"))];
    expect(failures.map((failure) => failure.message)).toEqual([STORAGE_ROW, CONNECTION_ROW]);
    expect(render(0, failures)).toContain(`None of the 2 files arrived. The reason is under each file. ${CONNECTION_SUMMARY}`);
  });

  it("a mix of no answer and our side: the connection wording", async () => {
    const failures = [await failed(async () => html502()), await failed(threw), await failed(async () => empty500())];
    expect(failures.map((failure) => failure.message)).toEqual([OUR_SIDE_ROW, CONNECTION_ROW, OUR_SIDE_ROW]);
    expect(render(0, failures)).toContain(`None of the 3 files arrived. The reason is under each file. ${CONNECTION_SUMMARY}`);
  });
});
