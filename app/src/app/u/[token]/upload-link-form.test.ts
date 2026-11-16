import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClientFileError, type ClientFileFailure } from "./send-file";
import { UploadSummary, failureOf } from "./upload-link-form";

const network: ClientFileFailure = {
  kind: "network",
  message: "The upload didn't finish. Check your connection and try again.",
};
const linkOff: ClientFileFailure = { kind: "refused", message: "This link is no longer active. Ask for a new one." };
const full: ClientFileFailure = { kind: "refused", message: "This workspace's storage is full. Ask them to make room." };

function render(sent: number, failures: ClientFileFailure[], total = sent + failures.length): string {
  return renderToStaticMarkup(createElement(UploadSummary, { sentCount: sent, failures, total }));
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
  it("refused only, one reason: the server's reason, no connection advice", () => {
    const odd: ClientFileFailure = { kind: "refused", message: "Check your connection settings in the link." };
    const html = render(0, [linkOff, linkOff]);
    expect(html).toContain('role="alert"');
    expect(html).toContain("None of the 2 files were sent. This link is no longer active. Ask for a new one.");
    expect(html).not.toContain("connection");
    expect(render(0, [odd])).not.toContain("then try again with the button below");
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
  it("treats anything else as a network failure, in plain words", () => {
    expect(failureOf(new TypeError("Failed to fetch"))).toEqual({
      kind: "network",
      message: "Something went wrong while sending this file. It may have arrived: if you send it again, it may arrive twice.",
    });
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
    expect(source).toMatch(/focusAfterPress\(submitter, \(\) => sendRef\.current\)/);
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
    expect(source).toMatch(
      /const submitter = \(event\.nativeEvent as SubmitEvent\)\.submitter;\s+const stopPressWatch =\s+submitter !== sendRef\.current \? focusAfterPress\(submitter, \(\) => sendRef\.current\) : \(\) => \{\};/,
    );
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
