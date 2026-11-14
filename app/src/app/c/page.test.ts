import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CONNECT_LINK_REOPEN_MESSAGE } from "@/lib/connectLink";

import ConnectLinkReopenPage, { metadata } from "./page";

describe("/c with no token", () => {
  it("tells the visitor to open the link they were sent again", () => {
    const html = renderToStaticMarkup(ConnectLinkReopenPage() as ReactElement);
    expect(html).toContain(CONNECT_LINK_REOPEN_MESSAGE);
    expect(html).toContain("Vibe Socials");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
