import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ query: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

import { LinkedInSetupDialog } from "./linkedin-setup-dialog";

// The markup React builds on a first render. With `document` present this is
// the render hydration compares against the server's HTML.
function firstRender(query: string, inBrowser: boolean): string {
  navigation.query = query;
  if (inBrowser) {
    vi.stubGlobal("document", { body: {}, activeElement: null });
  }
  try {
    return renderToString(createElement(LinkedInSetupDialog));
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Same cause as ?choose= (pending-connection-dialog.test.ts): a dialog opened
// by the address must not be portalled into <body> on the hydrating render.
describe("LinkedInSetupDialog: first render is the same on the server and in the browser", () => {
  it("renders the same markup with ?linkedin_setup=true whether or not a document exists", () => {
    expect(firstRender("linkedin_setup=true", true)).toBe(
      firstRender("linkedin_setup=true", false),
    );
  });

  it("renders nothing before hydration, so the dialog opens only after it", () => {
    expect(firstRender("linkedin_setup=true", true)).toBe("");
  });
});
