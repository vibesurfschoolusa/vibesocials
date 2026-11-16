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
    return renderToString(createElement(LinkedInSetupDialog, { workspaceId: "ws-1" }));
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

// R29 lead review: after a LinkedIn Reconnect the card shows Reconnect, not
// Connect, so the step names no button the card may not show.
describe("LinkedInSetupDialog: the wrong-account step", () => {
  it("says to try again from the LinkedIn card, naming no button", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./linkedin-setup-dialog.tsx", import.meta.url)), "utf8");
    expect(source).toContain(", then close this and try again from the LinkedIn card.");
    expect(source).not.toContain("click Connect again");
  });
});

// R31 pages L4: the empty-field error was a plain span and focus stayed on the button.
describe("LinkedInSetupDialog: the empty-field error", () => {
  it("is announced (role=\"alert\") and focus moves to the input", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./linkedin-setup-dialog.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/<span id="vanity-name-error" role="alert"/);
    expect(source).toMatch(
      /setFieldError\("Enter your LinkedIn company page URL or vanity name\."\);\s+inputRef\.current\?\.focus\(\);\s+return;/,
    );
    expect(source).toMatch(/<Input\s+ref=\{inputRef\}\s+id="vanity-name"/);
  });
});
