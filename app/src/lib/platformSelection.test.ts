import { describe, expect, it } from "vitest";

import { platformListAlert } from "@/components/create-post-form";

import { NO_PLATFORM_SELECTED_MESSAGE } from "./platformSelection";

describe("the no-platform line", () => {
  it("is the sentence Create shows when nothing is ticked", () => {
    expect(platformListAlert({ selectedCount: 0, allDisabled: false, noFile: false, triedSend: false })).toBe(
      NO_PLATFORM_SELECTED_MESSAGE,
    );
  });
});
