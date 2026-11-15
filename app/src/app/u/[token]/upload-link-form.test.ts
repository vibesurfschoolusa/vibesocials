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

  it("treats anything else as a network failure, in plain words", () => {
    expect(failureOf(new TypeError("Failed to fetch"))).toEqual({
      kind: "network",
      message: "Couldn't reach Vibe Socials. Check your connection and try again.",
    });
  });
});
