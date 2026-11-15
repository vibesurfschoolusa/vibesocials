import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SetPostingTimesPrompt } from "./posting-times-prompt";

// R12-pages L2: only an owner can add posting times; a member's card is read-only.
describe("SetPostingTimesPrompt", () => {
  it("owner: the link to Settings, Posting times, as before", () => {
    const html = renderToStaticMarkup(createElement(SetPostingTimesPrompt, { isMember: false }));
    expect(html).toBe(
      '<a class="text-sm font-medium text-primary underline-offset-4 hover:underline" href="/settings#posting-times">Set your posting times</a>',
    );
  });

  it("member: who can add them, no link", () => {
    const html = renderToStaticMarkup(createElement(SetPostingTimesPrompt, { isMember: true }));
    expect(html).toContain("The workspace owner can add posting times.");
    expect(html).not.toContain("<a");
  });
});
