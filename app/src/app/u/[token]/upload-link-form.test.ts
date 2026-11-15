import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UploadSummary } from "./upload-link-form";

function render(sent: number, failed: number, total = sent + failed): string {
  return renderToStaticMarkup(createElement(UploadSummary, { sentCount: sent, failedCount: failed, total }));
}

describe("UploadSummary, after the files were sent", () => {
  it("thanks the client as a status when every file arrived", () => {
    const html = render(2, 0);
    expect(html).toContain('role="status"');
    expect(html).toContain("2 files arrived. Thank you.");
  });

  it("says how many arrived as a status when some did not", () => {
    const html = render(2, 1);
    expect(html).toContain('role="status"');
    expect(html).toContain("2 of 3 files arrived. The others are marked below.");
  });

  // R5-pages L9: when nothing arrived the page said nothing at all.
  it("announces it as an alert when no file arrived, with what to do next", () => {
    const html = render(0, 3);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Nothing was sent");
    expect(html).toContain(
      "None of the 3 files arrived. The reason is under each file. Check your connection, then try again with the button below.",
    );
  });

  it("names one file as the file", () => {
    expect(render(0, 1)).toContain(
      "The file didn&#x27;t arrive. The reason is under it. Check your connection, then try again with the button below.",
    );
  });
});
