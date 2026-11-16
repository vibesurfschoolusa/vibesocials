import { createElement } from "react";

import { choiceAddress } from "@/lib/choicePlatform";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import {
  CHOICE_MAYBE_CONNECTED_MESSAGE,
  CANCEL_FAILED_MESSAGE,
  CANCEL_LOST_MESSAGE,
  ConnectLinkChoiceView,
  cancelOutcome,
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

  // R30 lead review: the loading view comes and goes, so the line is read through
  // the page's announcer (components/ui/announcer.tsx), not a region of its own.
  it("says it is loading, read through the announcer", () => {
    const html = view({ state: { status: "loading" } });
    expect(html).toBe('<p class="text-sm text-muted-foreground">Loading the accounts…</p>');
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

  // R31 client-journey L2: an expired choice, or a link turned off, kept its Connect buttons.
  it("choose: any 404 means the choice is gone: its sentence replaces the buttons", () => {
    expect(chooseFailure(404, { error: "This choice has ended: it expired, or an account was already chosen. The list below shows what is connected." })).toEqual({
      gone: true,
      message: "This choice has ended: it expired, or an account was already chosen. The list below shows what is connected.",
    });
    expect(chooseFailure(404, { error: "This link is no longer active." })).toEqual({ gone: true, message: "This link is no longer active." });
    expect(chooseFailure(404, null)).toEqual({
      gone: true,
      message: "This choice has ended: it expired, or an account was already chosen. The list below shows what is connected.",
    });
  });

  // R32 client-journey L2: the place was taken while the client chose; the choice is over.
  it("choose: a 409 marked connected ends the choice like a 404", () => {
    const sentence = "Facebook Page is already connected. Ask the person who sent you this link if it should be changed.";
    expect(chooseFailure(409, { error: sentence, connected: true })).toEqual({ gone: true, message: sentence });
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

// R30 client-journey L1 and L2: after a lost Connect answer the choice may
// already be used, so a gone answer reloads the rows, and Cancel says "You
// cancelled" only when the DELETE cancelled it.
describe("the account choice after a lost Connect answer (R30)", () => {
  const source = async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    return readFileSync(fileURLToPath(new URL("./connect-link-choice.tsx", import.meta.url)), "utf8");
  };

  it("a gone Connect answer reads the page again, so the rows match the sentence", async () => {
    expect(await source()).toMatch(
      /if \(failure\.gone\) \{\s+focusAfterPress\(pressed, \(\) => goneRef\.current\);\s+setState\(\{ status: "gone", message: failure\.message \}\);\s+(?:\/\/[^\n]*\s+)?router\.refresh\(\);/,
    );
  });

  it("Cancel: a cancelled choice says so", () => {
    expect(cancelOutcome(200, null, "instagram", "/c/t")).toEqual({ go: "/c/t?error=instagram_cancelled" });
  });

  it("Cancel: a choice already used, with its platform now connected, goes to the page with the success code", () => {
    expect(cancelOutcome(404, { error: "Instagram is connected. There is nothing more to choose here.", connected: true }, "instagram", "/c/t")).toEqual({
      go: "/c/t?success=instagram_connected",
    });
  });

  it("Cancel: a choice that has ended otherwise goes to the page with no code", () => {
    expect(cancelOutcome(404, { error: "This choice has ended: it expired, or an account was already chosen." }, "instagram", "/c/t")).toEqual({
      go: "/c/t",
    });
    expect(cancelOutcome(404, null, "instagram", "/c/t")).toEqual({ go: "/c/t" });
  });

  it("Cancel: any other answer stays and says it wasn't cancelled", () => {
    for (const status of [500, 502, 429]) {
      expect(cancelOutcome(status, null, "instagram", "/c/t")).toEqual({ error: CANCEL_FAILED_MESSAGE });
    }
    expect(CANCEL_FAILED_MESSAGE).not.toMatch(/cancelled/);
  });

  it("Cancel: the route's own sentence when it has one, as Connect shows", () => {
    expect(cancelOutcome(429, { error: "Too many tries from this link. Wait a few minutes, then try again." }, "instagram", "/c/t")).toEqual({
      error: "Too many tries from this link. Wait a few minutes, then try again.",
    });
  });

  it("Cancel: a lost answer may have cancelled it, and says so in the shared words", async () => {
    expect(CANCEL_LOST_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so the choice may already be cancelled. If your connection dropped, reconnect first. Press Cancel again, or leave this page: the choice ends by itself in 15 minutes.",
    );
    expect(await source()).toMatch(/\} catch \{\s+outcome = \{ error: CANCEL_LOST_MESSAGE \};/);
  });

  it("Cancel reads the DELETE answer, asking with the platform so a used choice can say it is connected", async () => {
    const text = await source();
    expect(text).toMatch(/fetchOrNoAnswer\(choiceAddress\(base, platform\), \{ method: "DELETE" \}\)/);
    expect(text).toMatch(/cancelOutcome\(response\.status, data, platform, page\)/);
  });
});
