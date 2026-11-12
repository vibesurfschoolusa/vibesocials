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

// P1: Settings, Plan says what each plan includes, and on Starter what Growth adds.
describe("PlanSection: what the plans include", () => {
  it("shows one line per plan it offers", () => {
    const html = renderToStaticMarkup(
      createElement(PlanSection, {
        label: "Free trial",
        usage: null,
        offers: [
          { plan: "starter", name: "Starter", price: "$19 a month" },
          { plan: "growth", name: "Growth", price: null },
        ],
      }),
    );
    expect(html).toContain("Starter: All your platforms, AI captions and alt text");
    expect(html).toContain("Growth: Everything in Starter, plus client upload, review and connect links");
    expect(html).not.toContain("Pro:");
  });

  it("shows what Growth adds when asked to", () => {
    const html = renderToStaticMarkup(createElement(PlanSection, { label: "Starter plan", usage: null, growthAdds: true }));
    expect(html).toContain("Growth adds client upload, review and connect links");
  });

  it("shows neither by default, so the section is as before", () => {
    const html = renderToStaticMarkup(createElement(PlanSection, { label: "Manage", usage: null }));
    expect(html).not.toContain("Everything in");
    expect(html).not.toContain("Growth adds");
  });
});

// P1 fix round 2: Settings writes each line from the plans it offers.
describe("PlanSection: lines from the plans offered", () => {
  it("does not say 'Everything in Growth' when Growth is not offered", () => {
    const html = renderToStaticMarkup(
      createElement(PlanSection, {
        label: "Free trial",
        usage: null,
        offers: [
          { plan: "starter", name: "Starter", price: null },
          { plan: "pro", name: "Pro", price: null },
        ],
      }),
    );
    expect(html).not.toContain("Everything in Growth");
    expect(html).toContain("Pro: Everything in Starter, plus client upload");
  });
});

// Q1: an owner on a plan switches through the portal, which lists every price.
describe("PlanSection: how to switch plans", () => {
  const SWITCH = "To switch plans, use Manage plan, card and invoices.";

  it("after the Growth adds line, where the portal button shows", () => {
    const html = renderToStaticMarkup(createElement(PlanSection, { label: "Starter plan", usage: null, growthAdds: true, manage: true }));
    expect(html).toContain(SWITCH);
    expect(html.indexOf(SWITCH)).toBeGreaterThan(html.indexOf("Growth adds"));
  });

  it("not without the portal button, and not in the portal-only section with billing off", () => {
    expect(renderToStaticMarkup(createElement(PlanSection, { label: "Starter plan", usage: null, growthAdds: true }))).not.toContain(SWITCH);
    expect(renderToStaticMarkup(createElement(PlanSection, { label: "Manage", usage: null, manage: true }))).not.toContain(SWITCH);
  });

  it("not for an ended plan, which chooses again", () => {
    const html = renderToStaticMarkup(
      createElement(PlanSection, {
        label: "Your plan has ended",
        usage: null,
        manage: true,
        offers: [{ plan: "starter", name: "Starter", price: "$19 a month" }],
      }),
    );
    expect(html).not.toContain(SWITCH);
  });
});
