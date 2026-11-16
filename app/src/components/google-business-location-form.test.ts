import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  GBP_RECONNECT_CODE,
  GBP_RECONNECT_MESSAGE,
} from "@/app/api/connections/google_business_profile/gbpLocations";

import {
  LOCATION_MESSAGES,
  LOCATION_RECONNECT_CODE,
  PickerStatusLine,
  locationFailure,
  locationsLoadedStatus,
} from "./google-business-location-form";
import { SignInAgainLink } from "./gbp-sign-in-link";

const formSource = readFileSync(path.join(__dirname, "google-business-location-form.tsx"), "utf8");

const signInLinkHtml = (href: string) => renderToStaticMarkup(createElement(SignInAgainLink, { href }));

// R5 new-customer L8 and pages L8: each message says what happened and what to do.
describe("Google location form messages", () => {
  // R25 client-journey L1: Switch account deletes the listing's numbers; the
  // in-place sign-in keeps them, so the empty list points at that instead.
  it("an empty list says to sign in to Google again with the account that manages the listing", () => {
    expect(LOCATION_MESSAGES.noLocations).toContain("no business listing");
    expect(LOCATION_MESSAGES.noLocations).toContain("Sign in to Google again with the Google account that manages your listing");
    expect(LOCATION_MESSAGES.noLocations).not.toContain("Switch account");
  });

  it("no sentence of the form names Switch account any more", () => {
    expect(formSource).not.toContain("Switch account");
  });

  it("failures say nothing was saved or loaded and what to do next", () => {
    expect(LOCATION_MESSAGES.saveFailed).toBe("The location wasn't saved. Please try again in a minute.");
    expect(LOCATION_MESSAGES.saveOffline).toContain("Check your internet connection");
    expect(LOCATION_MESSAGES.loadFailed).toBe(
      "Google didn't send the list of locations. Please press Fetch locations from Google again in a minute.",
    );
    expect(LOCATION_MESSAGES.loadOffline).toContain("Check your internet connection");
    for (const message of Object.values(LOCATION_MESSAGES)) {
      expect(message).not.toMatch(/^(Failed|Unexpected)/);
    }
  });
});

// R24 platform-clients L1: a revoked grant says to reconnect, and the card
// refreshes so it shows its Reconnect state without a manual reload.
describe("Google location form: a failed answer", () => {
  it("the routes' reconnect code asks the card to refresh, with the route's text", () => {
    expect(LOCATION_RECONNECT_CODE).toBe(GBP_RECONNECT_CODE);
    expect(
      locationFailure({ error: GBP_RECONNECT_MESSAGE, code: GBP_RECONNECT_CODE }, LOCATION_MESSAGES.loadFailed, "ws-1"),
    ).toEqual({ message: GBP_RECONNECT_MESSAGE, reconnect: true, signInUrl: null });
  });

  // JJ3 lead review: the route sends a flag; the form builds the link from its own workspace.
  it("a sign-in answer gives the start URL for the form's own workspace, never one from the answer", () => {
    expect(
      locationFailure(
        // A URL in the answer is never used.
        { error: "Sign in.", signIn: true, ...{ signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-B" } },
        LOCATION_MESSAGES.loadFailed,
        "ws-A",
      ),
    ).toEqual({
      message: "Sign in.",
      reconnect: false,
      signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-A",
    });
    expect(locationFailure({ error: "x", ...{ signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-B" } }, "F", "ws-A").signInUrl).toBeNull();
  });

  it("the form shows the link while a sign-in is asked for", () => {
    expect(signInLinkHtml("/api/auth/google_business_profile/start?workspaceId=ws-1")).toMatch(/<a [^>]*href="\/api\/auth\/google_business_profile\/start\?workspaceId=ws-1"[^>]*>Sign in to Google again<\/a>/);
  });

  it("any other error keeps its text and does not refresh", () => {
    expect(locationFailure({ error: "Google didn't answer. Try again in a minute." }, LOCATION_MESSAGES.loadFailed, "ws-1")).toEqual({
      message: "Google didn't answer. Try again in a minute.",
      reconnect: false,
      signInUrl: null,
    });
  });

  it("no JSON body gives the form's own sentence", () => {
    expect(locationFailure(null, LOCATION_MESSAGES.saveFailed, "ws-1")).toEqual({
      message: LOCATION_MESSAGES.saveFailed,
      reconnect: false,
      signInUrl: null,
    });
  });
});

// JJ3 lead review: accounts whose locations Google would not send are said,
// with why, instead of being left out without a word. R25 pages L4: in the
// form's status region, not in an info toast that vanishes.
describe("Google location form: what a loaded list says", () => {
  const notice = "Google refused access to some of your Business Profile accounts, so their locations aren't listed.";

  it("the route's notice, with or without locations", () => {
    expect(locationsLoadedStatus(3, notice, "ws-1")).toEqual({ message: notice, signInUrl: null });
    expect(locationsLoadedStatus(0, notice, "ws-1")).toEqual({ message: notice, signInUrl: null });
  });

  it("an empty list without a notice: the sign-in step, with the link for the form's own workspace", () => {
    expect(locationsLoadedStatus(0, undefined, "ws-A")).toEqual({
      message: LOCATION_MESSAGES.noLocations,
      signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-A",
    });
  });

  it("a full list: nothing to say", () => {
    expect(locationsLoadedStatus(2, undefined, "ws-1")).toBeNull();
    expect(locationsLoadedStatus(2, 42, "ws-1")).toBeNull();
  });
});

// R25 pages L4: the form's sentences stay on the page in one status region.
describe("Google location form: where its sentences show", () => {
  it("no info toast; the list's sentence and any failure go in a status region that stays on the page", () => {
    expect(formSource).not.toContain("toast.info(");
    expect(formSource).toMatch(/<div role="status"[^>]*empty:sr-only/);
    const region = formSource.slice(formSource.indexOf('<div role="status"'), formSource.indexOf("Primary flow"));
    expect(region).toContain("{failure ? <PickerStatusLine status={failure} /> : null}");
    expect(region).toContain("{listNote ? <PickerStatusLine status={listNote} /> : null}");
  });

  it("the access wording is the route's, not the form's own", () => {
    expect(formSource).not.toContain("Google didn&apos;t accept the connection");
  });

  it("a status line shows its sentence and, when asked, the sign-in link", () => {
    const html = renderToStaticMarkup(
      createElement(PickerStatusLine, {
        status: { message: "Sign in to Google again with the account that manages this location.", signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-1" },
      }),
    );
    expect(html).toMatch(/<p[^>]*>Sign in to Google again with the account that manages this location\.<\/p><a [^>]*href="\/api\/auth\/google_business_profile\/start\?workspaceId=ws-1"/);
    const plain = renderToStaticMarkup(createElement(PickerStatusLine, { status: { message: "Try again.", signInUrl: null } }));
    expect(plain).not.toContain("<a ");
  });
});
