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
  PICK_SAVING_STATUS,
  PickerStatusLine,
  pickStatusText,
  locationFailure,
  locationsLoadedStatus,
  pickAfterSave,
  saveFailureAt,
  savedLocationLine,
} from "./google-business-location-form";
import { SignInAgainLink } from "./gbp-sign-in-link";

const formSource = readFileSync(path.join(__dirname, "google-business-location-form.tsx"), "utf8");

const signInLinkHtml = (href: string) => renderToStaticMarkup(createElement(SignInAgainLink, { href }));

// R5 new-customer L8 and pages L8: each message says what happened and what to do.
describe("Google location form messages", () => {
  // R25 client-journey L1, after KK1: the route words the empty list itself
  // (GBP_NO_LISTING_NOTICE); the form keeps only a short fallback, which names
  // no control (Switch account deletes the listing's numbers).
  it("an empty list's fallback, for an answer with no notice, names no control", () => {
    expect(LOCATION_MESSAGES.noLocations).toBe(
      "Google sent no locations for this Google account. Check in Google Business Profile that this account manages your listing.",
    );
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

  // R25 (KK1): the reconnect answer carries signIn too, but the card refreshes
  // to its own Reconnect button (the same URL), so the form adds no second control.
  it("a reconnect answer with signIn: no link in the form, the card's Reconnect is the one control", () => {
    expect(
      locationFailure({ error: GBP_RECONNECT_MESSAGE, code: GBP_RECONNECT_CODE, signIn: true }, LOCATION_MESSAGES.loadFailed, "ws-1"),
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
    expect(signInLinkHtml("/api/auth/google_business_profile/start?workspaceId=ws-1")).toMatch(/<a [^>]*href="\/api\/auth\/google_business_profile\/start\?workspaceId=ws-1"[^>]*>Sign in to Google again <span[^>]*>\(opens in a new tab\)<\/span><\/a>/);
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
    expect(locationsLoadedStatus(3, { notice }, "ws-1")).toEqual({ message: notice, signInUrl: null });
    expect(locationsLoadedStatus(0, { notice }, "ws-1")).toEqual({ message: notice, signInUrl: null });
  });

  // KK1: an empty list answers { locations: [], notice, signIn: true } (200).
  it("a 200 with signIn: the route's notice and the link for the form's own workspace, never one from the answer", () => {
    expect(
      locationsLoadedStatus(0, { notice, signIn: true, ...{ signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-B" } }, "ws-A"),
    ).toEqual({ message: notice, signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-A" });
    expect(locationsLoadedStatus(0, { notice, signIn: "yes" }, "ws-A")).toEqual({ message: notice, signInUrl: null });
  });

  it("an empty list with no notice: the form's fallback, and no link the route didn't ask for", () => {
    expect(locationsLoadedStatus(0, {}, "ws-A")).toEqual({ message: LOCATION_MESSAGES.noLocations, signInUrl: null });
    expect(locationsLoadedStatus(0, null, "ws-A")).toEqual({ message: LOCATION_MESSAGES.noLocations, signInUrl: null });
    expect(locationsLoadedStatus(0, { signIn: true }, "ws-A")).toEqual({
      message: LOCATION_MESSAGES.noLocations,
      signInUrl: "/api/auth/google_business_profile/start?workspaceId=ws-A",
    });
  });

  it("a full list: nothing to say", () => {
    expect(locationsLoadedStatus(2, {}, "ws-1")).toBeNull();
    expect(locationsLoadedStatus(2, { notice: 42 }, "ws-1")).toBeNull();
  });

  it("the form hands it the whole answer", () => {
    expect(formSource).toContain("setListNote(locationsLoadedStatus(list.length, data, workspaceId))");
  });
});

// R25 pages L4: the form's sentences stay on the page in one status region.
describe("Google location form: where its sentences show", () => {
  it("no info toast; the list's sentence and a Fetch failure go in a status region right after Fetch", () => {
    expect(formSource).not.toContain("toast.info(");
    const fetchButton = formSource.indexOf('"Fetch locations from Google"}');
    const region = formSource.indexOf('<div id="gbp-fetch-status" role="status"');
    expect(fetchButton).toBeGreaterThan(-1);
    expect(region).toBeGreaterThan(fetchButton);
    expect(region).toBeLessThan(formSource.indexOf('<Label htmlFor="gbp-location-select">'));
    const body = formSource.slice(region, formSource.indexOf("</div>", region));
    expect(body).toContain("{fetchFailure ? <PickerStatusLine status={fetchFailure} /> : null}");
    expect(body).toContain("{listNote ? <PickerStatusLine status={listNote} /> : null}");
  });

  // Lead review: a Save failure shows by the control that saved (a phone may
  // not show the top of the form), in its own status region the control names.
  it("a save failure shows by the control that saved, which it describes", () => {
    expect(formSource).toMatch(/<Select[^>]*id="gbp-location-select"[^>]*aria-describedby="gbp-pick-status"/);
    expect(formSource).toContain('<div id="gbp-pick-status" role="status" className={pickStatus ? "flex flex-col items-start gap-2" : "sr-only"}>');
    expect(formSource).toMatch(/<Input\s+id="gbp-location"[^>]*aria-describedby="gbp-save-status"/);
    expect(formSource).toMatch(/<div id="gbp-save-status" role="status"[^>]*empty:sr-only/);
    expect(formSource.indexOf('id="gbp-save-status"')).toBeGreaterThan(formSource.indexOf('"Save location"'));
  });

  it("each save failure is shown once, by its own control", () => {
    const status = { message: "The location wasn't saved.", signInUrl: null };
    expect(saveFailureAt({ from: "pick", status }, "pick")).toBe(status);
    expect(saveFailureAt({ from: "pick", status }, "field")).toBeNull();
    expect(saveFailureAt({ from: "field", status }, "field")).toBe(status);
    expect(saveFailureAt(null, "field")).toBeNull();
  });

  // Lead follow-up: each failure is said once, in the region that stays, so a
  // screen reader hears it once; only the success of a save is a toast.
  it("no failure is also a toast", () => {
    expect(formSource).not.toContain("toast.error(");
    expect(formSource).toContain("toast.success(");
    expect(formSource).toContain('setSaveFailure({ from: "field", status: { message: "Enter a location resource name or store code.", signInUrl: null } })');
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

// R26 new-customer L1: after a failed save the same location could not be
// picked again (an uncontrolled select fires only on a change), and an
// Advanced save read as if nothing were saved. Pages L1: the dropdown keeps
// focus while saving.
describe("Google location form: the dropdown after a save", () => {
  it("is controlled, and empties after a failed save so the same location can be picked again", () => {
    expect(pickAfterSave("accounts/1/locations/2", "pick", false)).toBe("");
    expect(pickAfterSave("accounts/1/locations/2", "pick", true)).toBe("accounts/1/locations/2");
    // A save from the Advanced field leaves the dropdown on its placeholder.
    expect(pickAfterSave("STORE-1", "field", true)).toBe("");
    expect(pickAfterSave("STORE-1", "field", false)).toBe("");
    expect(formSource).toMatch(/<Select[^>]*id="gbp-location-select"[^>]*value=\{picked\}/);
    expect(formSource).not.toContain('defaultValue=""');
    const save = formSource.slice(formSource.indexOf("async function saveLocation"), formSource.indexOf("async function handleSubmit"));
    expect(save.match(/setPicked\(pickAfterSave\(name, from, (true|false)\)\)/g)).toHaveLength(3);
  });

  it("stays focusable while a save runs, and ignores a change until it ends", () => {
    const select = formSource.slice(formSource.indexOf('<Select\n'), formSource.indexOf("</Select>"));
    expect(select).not.toMatch(/\sdisabled=/);
    expect(select).toContain("aria-disabled={saving}");
    const onPickAt = formSource.indexOf("function handleSelectLocation");
    const onPick = formSource.slice(onPickAt, formSource.indexOf("return (\n", onPickAt));
    expect(onPick).toMatch(/if \(!value \|\| saving\) \{\s*return;/);
    expect(onPick).toContain("setPicked(value);");
  });

  it("says what is saved, a pasted store code or resource name included", () => {
    expect(savedLocationLine("Joe's Pizza", "accounts/1/locations/2")).toBe(
      "Posting to Joe's Pizza. Press Fetch locations from Google to choose another.",
    );
    expect(savedLocationLine(null, "STORE-1")).toBe(
      "Posting to the location you saved (STORE-1). Press Fetch locations from Google to choose it by name.",
    );
    expect(savedLocationLine(null, null)).toBe("Press Fetch locations from Google and choose the one to post to.");
    expect(savedLocationLine(null, "  ")).toBe("Press Fetch locations from Google and choose the one to post to.");
    expect(formSource).toContain("{savedLocationLine(savedTitle, savedName)}");
    const save = formSource.slice(formSource.indexOf("async function saveLocation"), formSource.indexOf("async function handleSubmit"));
    expect(save).toContain("setSavedName(name);");
  });
});

// LL2 lead review: while a save runs the dropdown looks unavailable, and its
// status region says why a change springs back.
describe("Google location form: the dropdown while saving", () => {
  const select = formSource.slice(formSource.indexOf("<Select\n"), formSource.indexOf("</Select>"));

  it("has the unavailable look while aria-disabled", () => {
    expect(select).toContain("aria-disabled={saving}");
    expect(select).toContain('className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"');
  });

  // LL2 after rebase: one region, on the page from the first render, whose one
  // text node changes (Saving…, the failure, or nothing), so it is heard once per change.
  it("one status line by the dropdown: Saving…, then the failure, else nothing", () => {
    expect(PICK_SAVING_STATUS).toBe("Saving…");
    const failure = { message: "The location wasn't saved. Please try again in a minute.", signInUrl: null };
    expect(pickStatusText("pick", null)).toBe("Saving…");
    expect(pickStatusText("pick", failure)).toBe("Saving…");
    expect(pickStatusText(null, failure)).toBe(failure.message);
    expect(pickStatusText(null, null)).toBe("");
  });

  // LL2 second review: an Advanced save says Saving… on its own button, not by
  // the dropdown (which may not be shown).
  it("an Advanced save says nothing by the dropdown", () => {
    expect(pickStatusText("field", null)).toBe("");
    expect(formSource).toContain("const pickStatus = pickStatusText(savingFrom, pickFailure);");
    expect(formSource).toContain("const saving = savingFrom !== null;");
    const save = formSource.slice(formSource.indexOf("async function saveLocation"), formSource.indexOf("async function handleSubmit"));
    expect(save).toContain("setSavingFrom(from);");
    expect(save.match(/setSavingFrom\(null\);/g)).toHaveLength(3);
    expect(formSource).not.toContain("setSaving(");
  });

  it("the region is drawn from the first render, outside the dropdown's own block", () => {
    const blockAt = formSource.indexOf("{locations && locations.length > 0 ? (");
    const block = formSource.slice(blockAt, formSource.indexOf(") : null}", blockAt));
    expect(block).toContain("</Select>");
    // The dropdown names the region (aria-describedby); the region itself is outside.
    expect(block).toContain('aria-describedby="gbp-pick-status"');
    expect(block).not.toContain('<div id="gbp-pick-status"');
    const regionAt = formSource.indexOf('<div id="gbp-pick-status"');
    expect(regionAt).toBeGreaterThan(formSource.indexOf("</Select>"));
    const region = formSource.slice(regionAt, formSource.indexOf("</div>", regionAt));
    expect(region).toContain('<p className="text-sm text-muted-foreground">{pickStatus}</p>');
    expect(region).toContain("{!saving && pickFailure?.signInUrl ? <SignInAgainLink href={pickFailure.signInUrl} /> : null}");
    expect(formSource).toContain("const pickStatus = pickStatusText(savingFrom, pickFailure);");
  });
});

// LL2 second review: the saved line names the button by its real label.
describe("Google location form: the saved line names the real button", () => {
  it("says Fetch locations from Google, the button's own label", () => {
    expect(formSource).toContain('"Fetch locations from Google"}');
    expect(savedLocationLine(null, "STORE-1")).toContain("Fetch locations from Google");
    expect(savedLocationLine("Joe's Pizza", "accounts/1/locations/2")).toContain("Fetch locations from Google");
    expect(savedLocationLine(null, null)).toContain("Fetch locations from Google");
    // No sentence names a control that isn't on the page.
    expect(formSource).not.toContain("Load your locations");
  });
});
