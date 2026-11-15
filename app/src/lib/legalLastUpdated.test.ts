import { describe, expect, it } from "vitest";

import { BILLING_TERMS_LAST_UPDATED } from "./billingTerms";
import { PRIVACY_LAST_UPDATED, billingOnLastUpdated, legalDateValue, privacyLastUpdated } from "./legalLastUpdated";
import { LEGAL_LAST_UPDATED } from "./siteInfo";

/** The Terms' and Privacy's "Last updated" with billing on: the later of the two texts' dates. */

describe("legalDateValue", () => {
  it("reads a date written the way the legal pages write it", () => {
    expect(legalDateValue("November 12, 2026")).toBe(Date.UTC(2026, 10, 12));
    expect(legalDateValue("January 1, 2027")).toBe(Date.UTC(2027, 0, 1));
    expect(legalDateValue("December 31, 2026")).toBe(Date.UTC(2026, 11, 31));
  });

  it("is NaN for anything else", () => {
    for (const label of ["", "2026-11-12", "Nov 12, 2026", "November 12 2026", "Smarch 12, 2026", "November 32, 2026"]) {
      expect(legalDateValue(label)).toBeNaN();
    }
  });

  it("reads both dates the pages use today", () => {
    expect(legalDateValue(LEGAL_LAST_UPDATED)).not.toBeNaN();
    expect(legalDateValue(BILLING_TERMS_LAST_UPDATED)).not.toBeNaN();
  });
});

describe("billingOnLastUpdated", () => {
  it("is the billing text's date when the operator approved it after the rest changed", () => {
    expect(billingOnLastUpdated("December 2, 2026", "November 12, 2026")).toBe("December 2, 2026");
  });

  it("is the rest of the page's date when that changed after the billing text", () => {
    expect(billingOnLastUpdated("November 10, 2026", "November 12, 2026")).toBe("November 12, 2026");
  });

  it("is that date when both are the same day", () => {
    expect(billingOnLastUpdated("November 12, 2026", "November 12, 2026")).toBe("November 12, 2026");
  });

  it("keeps the billing text's date when either cannot be read, so the page still renders", () => {
    expect(billingOnLastUpdated("November 10, 2026", "12/11/2026")).toBe("November 10, 2026");
    expect(billingOnLastUpdated("soon", "November 12, 2026")).toBe("soon");
  });

  it("uses the two dates in the code by default", () => {
    const expected =
      legalDateValue(BILLING_TERMS_LAST_UPDATED) >= legalDateValue(LEGAL_LAST_UPDATED)
        ? BILLING_TERMS_LAST_UPDATED
        : LEGAL_LAST_UPDATED;
    expect(billingOnLastUpdated()).toBe(expected);
  });
});

// F7 (R1 H1): the privacy policy changed on its own, so it carries its own date;
// the Terms keep theirs.
describe("privacyLastUpdated", () => {
  it("is a date written the way the legal pages write it, no earlier than the shared one", () => {
    expect(legalDateValue(PRIVACY_LAST_UPDATED)).not.toBeNaN();
    expect(legalDateValue(PRIVACY_LAST_UPDATED)).toBeGreaterThanOrEqual(legalDateValue(LEGAL_LAST_UPDATED));
  });

  // R9-pages L3: the usage-count retention line changed the policy on 15 November.
  it("is the date of the policy's last change", () => {
    expect(PRIVACY_LAST_UPDATED).toBe("November 15, 2026");
  });

  it("billing off: the later of the privacy text's date and the shared date", () => {
    expect(privacyLastUpdated(false, "November 14, 2026", "November 12, 2026")).toBe("November 14, 2026");
    expect(privacyLastUpdated(false, "November 14, 2026", "December 1, 2026")).toBe("December 1, 2026");
  });

  it("billing on: the billing text counts too", () => {
    expect(privacyLastUpdated(true, "November 14, 2026", "November 12, 2026", "December 2, 2026")).toBe(
      "December 2, 2026",
    );
    expect(privacyLastUpdated(true, "November 14, 2026", "November 12, 2026", "November 10, 2026")).toBe(
      "November 14, 2026",
    );
  });

  it("billing off ignores the billing text's date", () => {
    expect(privacyLastUpdated(false, "November 14, 2026", "November 12, 2026", "December 2, 2026")).toBe(
      "November 14, 2026",
    );
  });

  it("an unreadable date is skipped, so the page still renders a date", () => {
    expect(privacyLastUpdated(false, "Nov 14", "November 12, 2026")).toBe("November 12, 2026");
  });

  it("defaults to today's texts", () => {
    expect(privacyLastUpdated(false)).toBe(PRIVACY_LAST_UPDATED);
  });
});
