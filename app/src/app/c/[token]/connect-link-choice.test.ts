import { createElement } from "react";

import { choiceAddress } from "@/lib/choicePlatform";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import {
  CHOICE_MAYBE_CONNECTED_MESSAGE,
  ConnectLinkChoiceView,
  chooseFailure,
  loadOutcome,
  type ConnectLinkChoiceViewProps,
} from "./connect-link-choice";

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
    const html = view({ state: { status: "gone", message: "This choice has ended." } });
    expect(html).toMatch(/<p role="alert"[^>]*>This choice has ended.<\/p>/);
  });

  it("says it is loading as a status", () => {
    expect(view({ state: { status: "loading" } })).toContain('role="status"');
  });
});

// R26 pages L1: the pressed Connect keeps keyboard focus (Button's loading,
// never disabled); the other accounts' Connect are aria-disabled.
describe("the connect link's account choice while one connects", () => {
  it("no Connect is disabled; the pressed one is busy, the others aria-disabled", () => {
    const buttons = view({ busy: "a" }).match(/<button[^>]*>/g) ?? [];
    const connects = buttons.slice(0, 2);
    expect(connects.join("")).not.toContain('disabled=""');
    expect(connects[0]).toContain('aria-busy="true"');
    expect(connects[1]).toContain('aria-disabled="true"');
  });
});

// R29 client-journey L3: after a lost answer the page named a Connect button
// the row didn't show, and an unreadable 5xx after the save said "Couldn't
// connect" though it was connected.
describe("the account choice's answers (R29)", () => {
  it("asks with the platform it was for, once known, so a gone choice can say it is connected", () => {
    expect(choiceAddress("/api/connect-link/t/pending/p", null)).toBe("/api/connect-link/t/pending/p");
    expect(choiceAddress("/api/connect-link/t/pending/p", "facebook_page")).toBe(
      "/api/connect-link/t/pending/p?platform=facebook_page",
    );
  });

  it("load: the accounts; the route's sentence when gone; an unreadable answer says to reload", () => {
    expect(loadOutcome(true, { platform: "facebook_page", candidates: [{ id: "a", name: "A" }] })).toEqual({
      status: "ready",
      platform: "facebook_page",
      candidates: [{ id: "a", name: "A" }],
    });
    expect(loadOutcome(false, { error: "Facebook Page is connected. There is nothing more to choose here.", connected: true })).toEqual({
      status: "gone",
      message: "Facebook Page is connected. There is nothing more to choose here.",
    });
    for (const data of [null, {}]) {
      const outcome = loadOutcome(false, data);
      expect(outcome).toEqual({ status: "gone", message: "Couldn't load the accounts. Reload this page." });
    }
  });

  it("choose: a gone choice whose platform is connected replaces the buttons with that sentence", () => {
    expect(chooseFailure(404, { error: "Facebook Page is connected. There is nothing more to choose here.", connected: true })).toEqual({
      gone: true,
      message: "Facebook Page is connected. There is nothing more to choose here.",
    });
  });

  it("choose: the route's own sentence stays under the buttons", () => {
    expect(chooseFailure(409, { error: "Pick the connected one." })).toEqual({ gone: false, message: "Pick the connected one." });
    expect(chooseFailure(500, { error: "Failed to connect the account." })).toEqual({
      gone: false,
      message: "Failed to connect the account.",
    });
  });

  it("choose: an unreadable 5xx or 2xx after the save may have connected it; reload to see", () => {
    for (const status of [200, 502, 504]) {
      expect(chooseFailure(status, null)).toEqual({ gone: false, message: CHOICE_MAYBE_CONNECTED_MESSAGE });
    }
    expect(CHOICE_MAYBE_CONNECTED_MESSAGE).toMatch(/may have been connected/);
    expect(CHOICE_MAYBE_CONNECTED_MESSAGE).toMatch(/Reload this page to see/);
  });

  it("choose: an unreadable 4xx (nothing saved) says to try again", () => {
    expect(chooseFailure(400, null)).toEqual({ gone: false, message: "Couldn't connect that account. Try again." });
  });

  it("no sentence on the page says Connect again", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./connect-link-choice.tsx", import.meta.url)), "utf8");
    expect(source).not.toContain("Connect again");
  });
});

// R29 lead review: a POST 404 with `connected` replaces the choice section with
// the alert; the pressed Connect is gone and focus fell to the Terms link.
describe("the account choice: focus when it is gone after a press", () => {
  it("the gone alert can take focus, and the press hands focus to it", async () => {
    const html = view({ state: { status: "gone", message: "Facebook Page is connected." } });
    expect(html).toMatch(/<p role="alert" tabindex="-1" class="[^"]*outline-none[^"]*">Facebook Page is connected.<\/p>/);
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./connect-link-choice.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/if \(failure\.gone\) \{\s+focusAfterPress\(pressed, \(\) => goneRef\.current\);\s+setState\(\{ status: "gone", message: failure\.message \}\);/);
    expect(source).toMatch(/onClick=\{\(event\) => onChoose\(candidate\.id, event\.currentTarget\)\}/);
    expect(source).toMatch(/<p ref=\{goneRef\} role="alert" tabIndex=\{-1\}/);
  });
});
