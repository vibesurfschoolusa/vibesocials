import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UploadSummary, failureSentence } from "./upload-link-form";

const NETWORK = "The upload didn't finish. Check your connection and try again.";
const LINK_OFF = "This link is no longer active. Ask for a new one.";
const FULL = "This workspace's storage is full. Ask them to make room.";

function render(sent: number, errors: string[], total = sent + errors.length): string {
  return renderToStaticMarkup(createElement(UploadSummary, { sentCount: sent, errors, total }));
}

describe("UploadSummary, after the files were sent", () => {
  it("thanks the client as a status when every file arrived", () => {
    const html = render(2, []);
    expect(html).toContain('role="status"');
    expect(html).toContain("2 files arrived. Thank you.");
  });

  it("says how many arrived as a status when some did not", () => {
    const html = render(2, [NETWORK]);
    expect(html).toContain('role="status"');
    expect(html).toContain("2 of 3 files arrived. The others are marked below.");
  });

  // R5-pages L9: when nothing arrived the page said nothing at all.
  it("announces network failures as an alert, with the connection advice", () => {
    const html = render(0, [NETWORK, NETWORK, NETWORK]);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Nothing was sent");
    expect(html).toContain(
      "None of the 3 files arrived. The reason is under each file. Check your connection, then try again with the button below.",
    );
  });

  it("names one file as the file", () => {
    expect(render(0, [NETWORK])).toContain(
      "The file didn&#x27;t arrive. The reason is under it. Check your connection, then try again with the button below.",
    );
  });

  // Review: a server's answer is not the connection's fault.
  it("gives the server's one reason when every file was refused for it", () => {
    const html = render(0, [LINK_OFF, LINK_OFF]);
    expect(html).toContain('role="alert"');
    expect(html).toContain("None of the 2 files were sent. This link is no longer active. Ask for a new one.");
    expect(html).not.toContain("connection");
  });

  it("points at each file's reason when they differ, or when network and server failures mix", () => {
    for (const errors of [[LINK_OFF, FULL], [FULL, NETWORK]]) {
      const html = render(0, errors);
      expect(html).toContain("None of the files were sent. See the reason under each file.");
      expect(html).not.toContain("connection");
    }
  });

  it("gives one refused file's reason", () => {
    expect(render(0, [FULL])).toContain("The file wasn&#x27;t sent. This workspace&#x27;s storage is full.");
  });
});

describe("failureSentence, what a failed file says", () => {
  it("turns the browser's network failure into the connection sentence", () => {
    expect(failureSentence(new TypeError("Failed to fetch"))).toEqual({
      network: true,
      message: "Couldn't reach Vibe Socials. Check your connection and try again.",
    });
  });

  it("keeps a sentence the upload gave, and says whether it is about the connection", () => {
    expect(failureSentence(new Error(NETWORK))).toEqual({ network: true, message: NETWORK });
    expect(failureSentence(new Error(LINK_OFF))).toEqual({ network: false, message: LINK_OFF });
  });
});
