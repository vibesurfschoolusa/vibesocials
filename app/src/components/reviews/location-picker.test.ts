import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { reviewsListedLocation } from "@/server/googleReviews";

import { LocationPicker, pickLocation } from "./location-picker";
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

// LL2 after LL1: the route's own mapping, as main now sends it.
describe("LocationPicker with the route's listed locations", () => {
  it("reads the address reviewsListedLocation sends", () => {
    const locations: Location[] = [
      reviewsListedLocation({ resourceName: "accounts/1/locations/11", title: "Joe's Pizza", storeCode: "J1", address: "1 Main St" }),
      reviewsListedLocation({ resourceName: "accounts/1/locations/22", title: "Joe's Pizza", storeCode: null, address: null }),
    ];
    expect(locations[0]).toMatchObject({ storeCode: "J1", address: "1 Main St" });
    const html = renderToStaticMarkup(
      createElement(LocationPicker, { locations, selectedLocation: null, onChange: () => {} }),
    ).replace(/&#x27;/g, "'");
    expect(html).toContain(`<option value="accounts/1/locations/11">Joe's Pizza (1 Main St)</option>`);
    expect(html).toContain(`<option value="accounts/1/locations/22">Joe's Pizza (location 2)</option>`);
  });
});

// R27 lead review: once the page knows it belongs to another workspace, the
// picker is locked, so the list, its name and the reply box stay until Reload.
describe("LocationPicker locked", () => {
  const two = [
    { name: "a", locationName: "A", title: "A" },
    { name: "b", locationName: "B", title: "B" },
  ] satisfies Location[];

  it("a pick while locked changes nothing (so no request is sent)", () => {
    const onChange = vi.fn();
    pickLocation("b", true, onChange);
    expect(onChange).not.toHaveBeenCalled();
    pickLocation("b", false, onChange);
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("is aria-disabled and keeps its value", () => {
    const html = renderToStaticMarkup(createElement(LocationPicker, { locations: two, selectedLocation: "a", onChange: () => {}, locked: true }));
    expect(html).toMatch(/<select[^>]*aria-disabled="true"/);
    expect(html).toContain('<option value="a" selected="">A</option>');
    const open = renderToStaticMarkup(createElement(LocationPicker, { locations: two, selectedLocation: "a", onChange: () => {} }));
    expect(open).not.toContain("aria-disabled=");
  });
});
