import { describe, expect, it, vi } from "vitest";

import { afterWorkspaceChange } from "./afterWorkspaceChange";

function fakeLocation() {
  return { assign: vi.fn(), reload: vi.fn() };
}

describe("afterWorkspaceChange", () => {
  // Leave and rename stay where they were (Settings), in full.
  it("loads the current page again in full when given no address", () => {
    const location = fakeLocation();
    afterWorkspaceChange(undefined, location);
    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(location.assign).not.toHaveBeenCalled();
  });

  // Join, delete and Open land on the dashboard; a new workspace on Settings.
  it("loads the given page in full", () => {
    const location = fakeLocation();
    afterWorkspaceChange("/settings", location);
    expect(location.assign).toHaveBeenCalledWith("/settings");
    expect(location.reload).not.toHaveBeenCalled();
  });
});
