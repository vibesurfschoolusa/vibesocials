import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocationPicker } from "./location-picker";
import type { Location } from "./types";

// R26 client-journey L4: the Reviews locations route now sends each listed
// location's address and store code (googleReviews.ts reviewsListedLocation),
// so same-named branches read their address, not "(location 1)".
describe("LocationPicker and same-named branches", () => {
  // As the route sends them; a branch with no address comes as null.
  const listed = [
    { name: "accounts/1/locations/11", locationName: "Joe's Pizza", title: "Joe's Pizza", address: "1 Main St, Dania", storeCode: "J1" },
    { name: "accounts/1/locations/22", locationName: "Joe's Pizza", title: "Joe's Pizza", address: "9 Pier St, Pompano", storeCode: "J2" },
    { name: "accounts/1/locations/33", locationName: "Joe's Pizza", title: "Joe's Pizza", address: null, storeCode: null },
  ] satisfies Location[];

  const html = renderToStaticMarkup(
    createElement(LocationPicker, { locations: listed, selectedLocation: null, onChange: () => {} }),
  ).replace(/&#x27;/g, "'");

  it("shows each branch's address", () => {
    expect(html).toContain('<option value="accounts/1/locations/11">Joe\'s Pizza (1 Main St, Dania)</option>');
    expect(html).toContain('<option value="accounts/1/locations/22">Joe\'s Pizza (9 Pier St, Pompano)</option>');
  });

  it("numbers only the branch with no address, and never shows a store code", () => {
    expect(html).toContain('<option value="accounts/1/locations/33">Joe\'s Pizza (location 3)</option>');
    expect(html).not.toContain("J1");
  });
});
