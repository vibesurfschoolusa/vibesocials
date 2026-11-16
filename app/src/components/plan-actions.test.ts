import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { onReturnFromCache, PlanActions } from "./plan-actions";

/** Q1: the Settings, Plan buttons as rendered (the first render, so Monthly). */

const MONTHLY = [
  { plan: "starter" as const, name: "Starter", price: "$19 a month" },
  { plan: "growth" as const, name: "Growth", price: "$39 a month" },
  { plan: "pro" as const, name: "Pro", price: "$79 a month" },
];

const render = (props: Omit<Parameters<typeof PlanActions>[0], "workspaceId">) =>
  renderToStaticMarkup(createElement(PlanActions, { workspaceId: "ws-1", ...props }));

describe("PlanActions with no yearly prices", () => {
  it("is today's markup exactly: three monthly buttons and no switch", () => {
    expect(render({ offers: MONTHLY, manage: false })).toMatchInlineSnapshot(`"<div class="flex flex-col gap-3"><div class="flex flex-wrap gap-2"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-10 px-4 text-sm">Choose Starter, $19 a month</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-10 px-4 text-sm">Choose Growth, $39 a month</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-10 px-4 text-sm">Choose Pro, $79 a month</button></div></div>"`);
  });

  it("is today's markup exactly with the portal button too (Q1: the switch line is the section's, not here)", () => {
    expect(render({ offers: MONTHLY, manage: true })).toMatchInlineSnapshot(`"<div class="flex flex-col gap-3"><div class="flex flex-wrap gap-2"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-10 px-4 text-sm">Choose Starter, $19 a month</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-10 px-4 text-sm">Choose Growth, $39 a month</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-10 px-4 text-sm">Choose Pro, $79 a month</button></div><div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 border border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground h-10 px-4 text-sm">Manage plan, card and invoices</button></div></div>"`);
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

// Unconfirmed in R7-new-customer: Back from Stripe Checkout restores the page
// from the browser's cache with the buttons still busy; they come back.
describe("onReturnFromCache", () => {
  function fakeWindow() {
    const listeners = new Map<string, (event: { persisted: boolean }) => void>();
    return {
      listeners,
      addEventListener: (type: string, listener: (event: { persisted: boolean }) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
  }

  it("calls back when the page is shown again from the cache, not on a fresh load", () => {
    const target = fakeWindow();
    const reset = vi.fn();
    onReturnFromCache(target as never, reset);
    target.listeners.get("pageshow")?.({ persisted: false });
    expect(reset).not.toHaveBeenCalled();
    target.listeners.get("pageshow")?.({ persisted: true });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("stops listening when the component goes", () => {
    const target = fakeWindow();
    const stop = onReturnFromCache(target as never, () => {});
    stop();
    expect(target.listeners.has("pageshow")).toBe(false);
  });
});

// R26 pages L1: the pressed plan button shows Button's loading and keeps focus;
// the others are aria-disabled and run() ignores a second press.
describe("PlanActions busy buttons", () => {
  it("loading on the pressed one, aria-disabled on the rest, never disabled", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./plan-actions.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/\sdisabled=\{busy/);
    expect(source).toContain("loading={busy === button.key}");
    expect(source).toContain('loading={busy === "portal"}');
    expect((source.match(/aria-disabled=\{busy !== null \|\| undefined\}/g) ?? []).length).toBe(3);
    expect(source).toMatch(/async function run\([^)]*\) \{\s*if \(busy !== null\) return;/);
  });
});

// R29 OO1 lead follow-up: a request with no answer (offline, or a gateway's
// page) may have reached Stripe, but starting Checkout or the portal charges
// nothing, so that is what the line says, true either way.
describe("openStripe when Vibe Socials doesn't answer", () => {
  it("says nothing was charged, to reconnect, then try again", async () => {
    const { openStripe, PLAN_NO_ANSWER_MESSAGE } = await import("./plan-actions");
    expect(PLAN_NO_ANSWER_MESSAGE).toBe(
      "Vibe Socials didn't answer, so nothing was charged. If your connection dropped, reconnect first; then try again.",
    );
    const answers = [
      async () => {
        throw new TypeError("Failed to fetch");
      },
      async () => new Response("<html>504</html>", { status: 504, headers: { "content-type": "text/html" } }),
    ];
    for (const answer of answers) {
      vi.stubGlobal("fetch", vi.fn(answer));
      await expect(openStripe("/api/billing/checkout", { plan: "pro" })).resolves.toBe(PLAN_NO_ANSWER_MESSAGE);
    }
    vi.unstubAllGlobals();
  });

  it("a refusal still shows the route's sentence", async () => {
    const { openStripe } = await import("./plan-actions");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Only an owner can change the plan." }, { status: 403 })));
    await expect(openStripe("/api/billing/portal")).resolves.toBe("Only an owner can change the plan.");
    vi.unstubAllGlobals();
  });
});
