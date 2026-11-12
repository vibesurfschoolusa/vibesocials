import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/plan-actions", () => ({ PlanActions: () => null }));

import { WORKSPACE_PLAN_SENTENCE } from "@/lib/planCopy";

import { PlanSection } from "./plan-section";

/** S1 item 3: Settings, Plan says that the plan covers this one workspace, with billing on. */
describe("PlanSection", () => {
  it("says a plan covers one workspace when asked to", () => {
    const html = renderToStaticMarkup(createElement(PlanSection, { label: "Free trial", usage: null, workspaceNote: true }));
    expect(html).toContain(WORKSPACE_PLAN_SENTENCE);
  });

  it("says nothing of it otherwise (the portal-only section with billing off)", () => {
    const html = renderToStaticMarkup(createElement(PlanSection, { label: "Manage", usage: null }));
    expect(html).not.toContain("Each plan covers");
  });
});
