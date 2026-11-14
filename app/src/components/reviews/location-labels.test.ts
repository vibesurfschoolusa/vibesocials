import { describe, expect, it } from "vitest";

import { locationLabels } from "./location-labels";
import type { Location } from "./types";

const loc = (name: string, title: string, extra: Partial<Location> = {}): Location => ({
  name,
  locationName: name,
  title,
  ...extra,
});

describe("locationLabels", () => {
  it("shows just the name for a unique location", () => {
    const labels = locationLabels([loc("accounts/1/locations/111", "Dania Beach"), loc("accounts/1/locations/222", "Pompano")]);
    expect(labels.get("accounts/1/locations/111")).toBe("Dania Beach");
    expect(labels.get("accounts/1/locations/222")).toBe("Pompano");
  });

  it("never shows the store code or the id", () => {
    const labels = locationLabels([loc("accounts/1/locations/16420539074122571315", "Vibe", { storeCode: "16420539074122571315" })]);
    expect(labels.get("accounts/1/locations/16420539074122571315")).toBe("Vibe");
  });

  it("numbers duplicate names in list order when there is no address", () => {
    const labels = locationLabels([loc("a", "Vibe"), loc("b", "Other"), loc("c", "Vibe")]);
    expect(labels.get("a")).toBe("Vibe (location 1)");
    expect(labels.get("c")).toBe("Vibe (location 2)");
    expect(labels.get("b")).toBe("Other");
  });

  it("adds the address line to duplicate names when the data has one", () => {
    const labels = locationLabels([
      loc("a", "Vibe", { address: "1 Beach Rd, Dania" }),
      loc("b", "Vibe", { address: "9 Pier St, Pompano" }),
    ]);
    expect(labels.get("a")).toBe("Vibe (1 Beach Rd, Dania)");
    expect(labels.get("b")).toBe("Vibe (9 Pier St, Pompano)");
  });

  it("falls back to a number only for the duplicates that lack an address", () => {
    const labels = locationLabels([loc("a", "Vibe", { address: "1 Beach Rd" }), loc("b", "Vibe")]);
    expect(labels.get("a")).toBe("Vibe (1 Beach Rd)");
    expect(labels.get("b")).toBe("Vibe (location 2)");
  });

  it("numbers duplicates that share the same address too", () => {
    const labels = locationLabels([loc("a", "Vibe", { address: "1 Beach Rd" }), loc("b", "Vibe", { address: "1 Beach Rd" })]);
    expect(labels.get("a")).toBe("Vibe (location 1)");
    expect(labels.get("b")).toBe("Vibe (location 2)");
  });

  // Lead fix: a blank option is unreadable and unselectable by name.
  it("names a location with no title, and numbers several of them", () => {
    expect(locationLabels([loc("a", "  ")]).get("a")).toBe("Unnamed location");
    const labels = locationLabels([loc("a", ""), loc("b", "Vibe"), loc("c", " ")]);
    expect(labels.get("a")).toBe("Unnamed location (location 1)");
    expect(labels.get("b")).toBe("Vibe");
    expect(labels.get("c")).toBe("Unnamed location (location 2)");
  });
});
