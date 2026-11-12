import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlanActions } from "./plan-actions";

/** Q1: the Settings, Plan buttons as rendered (the first render, so Monthly). */

const MONTHLY = [
  { plan: "starter" as const, name: "Starter", price: "$19 a month" },
  { plan: "growth" as const, name: "Growth", price: "$39 a month" },
  { plan: "pro" as const, name: "Pro", price: "$79 a month" },
];

const render = (props: Parameters<typeof PlanActions>[0]) => renderToStaticMarkup(createElement(PlanActions, props));

describe("PlanActions with no yearly prices", () => {
  it("is today's markup exactly: three monthly buttons and no switch", () => {
    expect(render({ offers: MONTHLY, manage: false })).toMatchInlineSnapshot(`"<div class="flex flex-col gap-3"><div class="flex flex-wrap gap-2"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-10 px-4 text-sm">Choose Starter, $19 a month</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-10 px-4 text-sm">Choose Growth, $39 a month</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-10 px-4 text-sm">Choose Pro, $79 a month</button></div></div>"`);
  });

  it("is today's markup exactly with the portal button too (Q1: the switch line is the section's, not here)", () => {
    expect(render({ offers: MONTHLY, manage: true })).toMatchInlineSnapshot(`"<div class="flex flex-col gap-3"><div class="flex flex-wrap gap-2"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-10 px-4 text-sm">Choose Starter, $19 a month</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-10 px-4 text-sm">Choose Growth, $39 a month</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-10 px-4 text-sm">Choose Pro, $79 a month</button></div><div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 border border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground h-10 px-4 text-sm">Manage plan, card and invoices</button></div></div>"`);
  });
});

describe("PlanActions with yearly prices", () => {
  const YEARLY = [
    { plan: "starter" as const, name: "Starter", price: "$190 a year", twoMonthsFree: true },
    { plan: "growth" as const, name: "Growth", price: "$390 a year", twoMonthsFree: true },
    { plan: "pro" as const, name: "Pro", price: "$790 a year", twoMonthsFree: true },
  ];

  it("shows a Monthly / Yearly switch, Monthly pressed, and only the three monthly buttons", () => {
    const html = render({ offers: MONTHLY, yearlyOffers: YEARLY, manage: false });
    expect(html).toMatch(/<div role="group" aria-label="Billing period"/);
    expect(html).toMatch(/<button type="button"[^>]*aria-pressed="true"[^>]*>Monthly<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*aria-pressed="false"[^>]*>Yearly<\/button>/);
    expect(html.match(/>Choose /g)).toHaveLength(3);
    expect(html).toContain("Choose Growth, $39 a month");
    expect(html).not.toContain("a year");
    expect(html).not.toContain("Two months free");
  });
});

describe("PlanActions with yearly prices only", () => {
  it("shows no switch, the yearly buttons, and the saving line only under a price it is true of", () => {
    const html = render({
      offers: [],
      manage: false,
      yearlyOffers: [
        { plan: "starter", name: "Starter", price: "$190 a year", twoMonthsFree: true },
        { plan: "growth", name: "Growth", price: "$400 a year", twoMonthsFree: false },
      ],
    });
    expect(html).not.toContain("Billing period");
    expect(html).toContain("Choose Starter, $190 a year");
    expect(html).toContain("Choose Growth, $400 a year");
    expect(html.match(/Two months free compared with monthly/g)).toHaveLength(1);
  });
});
