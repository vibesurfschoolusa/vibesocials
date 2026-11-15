import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ConnectLinkReopenPage, { metadata } from "./page";

// Reached by a bare /c, and by a connect flow that finished without its
// browser's cookie (server/connectLink/callback.ts): one text fits both.
describe("/c with no token", () => {
  it("says what happened in its h1 and tells the visitor to open the full link again, in the same browser", () => {
    const html = renderToStaticMarkup(ConnectLinkReopenPage() as ReactElement);
    expect(html).toMatch(/<h1[^>]*>Open your link again<\/h1>/);
    expect(html).toContain(
      "This page needs the full link you were sent. Open that link again from the message, in the same browser you started in.",
    );
    expect(html).toContain("Vibe Socials");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
