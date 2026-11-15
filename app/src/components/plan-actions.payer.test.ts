import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlanActions } from "./plan-actions";

/** Review of R5-security L2: the payer who is not an owner gets one portal button, named for them. */
describe("PlanActions for the payer", () => {
  it("names the portal button as asked", () => {
    const html = renderToStaticMarkup(
      createElement(PlanActions, { workspaceId: "ws-1", offers: [], manage: true, manageLabel: "Manage your payment" }),
    );
    expect(html).toContain("Manage your payment");
    expect(html).not.toContain("Manage plan, card and invoices");
  });

  it("keeps the owners' label by default", () => {
    const html = renderToStaticMarkup(createElement(PlanActions, { workspaceId: "ws-1", offers: [], manage: true }));
    expect(html).toContain("Manage plan, card and invoices");
  });
});
