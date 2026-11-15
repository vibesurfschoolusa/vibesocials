import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BatchSettingsFieldset } from "./batch-settings";

// P1 fix 1: nothing on the batch card changes while rows are sending. One
// disabled fieldset disables every control inside it natively, shared
// components (StoryPlacementSettings) included.
describe("Add many batch settings", () => {
  const render = (locked: boolean) =>
    renderToStaticMarkup(
      createElement(
        BatchSettingsFieldset,
        { locked },
        createElement("input", { id: "inner", type: "radio" }),
      ),
    );

  it("while sending: the fieldset is disabled", () => {
    expect(render(true)).toMatch(/^<fieldset[^>]*disabled=""[^>]*>.*<input id="inner"/);
  });

  it("after: enabled", () => {
    expect(render(false)).not.toContain("disabled");
    expect(render(false)).toContain('<input id="inner"');
  });
});
