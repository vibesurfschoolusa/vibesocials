import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ConnectLinkChoiceView, type ConnectLinkChoiceViewProps } from "./connect-link-choice";

function view(overrides: Partial<ConnectLinkChoiceViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ConnectLinkChoiceView, {
      state: {
        status: "ready",
        platform: "facebook_page",
        candidates: [
          { id: "a", name: "Surf Co" },
          { id: "b", name: "Surf Co Kids", detail: "Page" },
        ],
      },
      busy: null,
      error: null,
      onChoose: () => {},
      onCancel: () => {},
      ...overrides,
    }),
  );
}

describe("the connect link's account choice", () => {
  it("offers one Connect per account and Cancel", () => {
    const html = view();
    expect(html.match(/>Connect</g)).toHaveLength(2);
    expect(html).toContain("Surf Co Kids");
    expect(html).toContain("Cancel");
    expect(html).not.toContain('role="alert"');
  });

  // R5-pages L9: the answer to a press arrives later, so it is announced.
  it("announces a failed choice as an alert", () => {
    const html = view({ error: "Couldn't connect that account. Try again." });
    expect(html).toMatch(/<p role="alert"[^>]*>Couldn&#x27;t connect that account. Try again.<\/p>/);
  });

  it("announces that the choice is gone as an alert", () => {
    const html = view({ state: { status: "gone", message: "This choice expired. Connect again." } });
    expect(html).toMatch(/<p role="alert"[^>]*>This choice expired. Connect again.<\/p>/);
  });

  it("says it is loading as a status", () => {
    expect(view({ state: { status: "loading" } })).toContain('role="status"');
  });
});
