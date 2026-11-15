import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/plan-actions", () => ({ PlanActions: () => null }));

import { WORKSPACE_PLAN_SENTENCE } from "@/lib/planCopy";
import { OWNER_DAILY_POST_LIMIT } from "@/lib/usageLimits";

import { NO_PLAN_YET_LABEL } from "./planSectionView";

import { PlanSection } from "./plan-section";

/** S1 item 3: Settings, Plan says that the plan covers this one workspace, with billing on. */
describe("PlanSection", () => {
  it("says a plan covers one workspace when asked to", () => {
    const html = renderToStaticMarkup(createElement(PlanSection, { workspaceId: "ws-1", label: "Free trial", usage: null, workspaceNote: true }));
    expect(html).toContain(WORKSPACE_PLAN_SENTENCE);
  });

  it("says nothing of it otherwise (the portal-only section with billing off)", () => {
    const html = renderToStaticMarkup(createElement(PlanSection, { workspaceId: "ws-1", label: "Manage", usage: null }));
    expect(html).not.toContain("Each plan covers");
  });
});

// P1: Settings, Plan says what each plan includes, and on Starter what Growth adds.
describe("PlanSection: what the plans include", () => {
  it("shows one line per plan it offers", () => {
    const html = renderToStaticMarkup(
      createElement(PlanSection, { workspaceId: "ws-1",
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
    const html = renderToStaticMarkup(createElement(PlanSection, { workspaceId: "ws-1", label: "Starter plan", usage: null, growthAdds: true }));
    expect(html).toContain("Growth adds client upload, review and connect links");
  });

  it("shows neither by default, so the section is as before", () => {
    const html = renderToStaticMarkup(createElement(PlanSection, { workspaceId: "ws-1", label: "Manage", usage: null }));
    expect(html).not.toContain("Everything in");
    expect(html).not.toContain("Growth adds");
  });
});

// P1 fix round 2: Settings writes each line from the plans it offers.
describe("PlanSection: lines from the plans offered", () => {
  it("does not say 'Everything in Growth' when Growth is not offered", () => {
    const html = renderToStaticMarkup(
      createElement(PlanSection, { workspaceId: "ws-1",
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
    const html = renderToStaticMarkup(createElement(PlanSection, { workspaceId: "ws-1", label: "Starter plan", usage: null, growthAdds: true, manage: true }));
    expect(html).toContain(SWITCH);
    expect(html.indexOf(SWITCH)).toBeGreaterThan(html.indexOf("Growth adds"));
  });

  it("not without the portal button, and not in the portal-only section with billing off", () => {
    expect(renderToStaticMarkup(createElement(PlanSection, { workspaceId: "ws-1", label: "Starter plan", usage: null, growthAdds: true }))).not.toContain(SWITCH);
    expect(renderToStaticMarkup(createElement(PlanSection, { workspaceId: "ws-1", label: "Manage", usage: null, manage: true }))).not.toContain(SWITCH);
  });

  it("not for an ended plan, which chooses again", () => {
    const html = renderToStaticMarkup(
      createElement(PlanSection, { workspaceId: "ws-1",
        label: "Your plan has ended",
        usage: null,
        manage: true,
        offers: [{ plan: "starter", name: "Starter", price: "$19 a month" }],
      }),
    );
    expect(html).not.toContain(SWITCH);
  });
});

const USAGE = {
  postsToday: { used: 0, limit: 20, resetsAt: null },
  xPostsThisMonth: { used: 0, limit: 100, resetsAt: null },
  youtubeUploadsToday: { used: 0, limit: 5, resetsAt: null },
  storage: { used: 0, limit: 1024 ** 3, resetsAt: null },
};

// R8-new-customer L1: beside the workspace's number, the viewer's own one where it applies.
describe("PlanSection: posts per day", () => {
  type Reduced = "unconfirmed" | "first_day" | "first_day_unconfirmed" | null;
  const render = (personalPostNote: { limit: number; reduced: Reduced; untilFirstPayment?: boolean } | null) =>
    renderToStaticMarkup(createElement(PlanSection, { workspaceId: "ws-1", label: "Free trial", usage: USAGE, personalPostNote }));
  /** The first day ends at 00:00 UTC on Tuesday 17 November: the Usage counts' reset. */
  const FIRST_DAY_USAGE = { ...USAGE, postsToday: { used: 0, limit: 20, resetsAt: new Date("2026-11-17T00:00:00Z") } };
  const renderIn = (personalPostNote: { limit: number; reduced: Reduced }, timeZone: string | null) =>
    renderToStaticMarkup(
      createElement(PlanSection, { workspaceId: "ws-1", label: "Free trial", usage: FIRST_DAY_USAGE, personalPostNote, timeZone }),
    );

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // R9-pages L1: the first day of an account whose email isn't confirmed: both reasons, and when it ends.
  it("5 on the first day of an unconfirmed account: why, and 15 from 00:00 UTC in the viewer's time", () => {
    expect(renderIn({ limit: 5, reduced: "first_day_unconfirmed" }, "America/New_York")).toContain(
      "20 (up to 5 a day for you today: your account is new and your email isn&#x27;t confirmed yet. 15 from Monday, 7:00 PM EST (00:00 UTC) once you confirm it.)",
    );
    expect(renderIn({ limit: 5, reduced: "first_day_unconfirmed" }, null)).toContain(
      "20 (up to 5 a day for you today: your account is new and your email isn&#x27;t confirmed yet. 15 from 00:00 UTC once you confirm it.)",
    );
    expect(render({ limit: 5, reduced: "first_day_unconfirmed" })).not.toContain("each person can send");
  });

  it("the first day gives the viewer's own time too", () => {
    expect(renderIn({ limit: 5, reduced: "first_day" }, "America/New_York")).toContain(
      `then ${OWNER_DAILY_POST_LIMIT} from Monday, 7:00 PM EST (00:00 UTC))`,
    );
  });

  // R9-pages L4 and R10-pages M1: with billing on, paid workspaces are not
  // counted; free ones and plans not yet paid for (card trials) are.
  it("with billing on: your workspaces not yet paid for, for every reason", () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    expect(render({ limit: OWNER_DAILY_POST_LIMIT, reduced: null })).toContain(
      `20 (each person can send up to ${OWNER_DAILY_POST_LIMIT} a day across their workspaces not yet paid for)`,
    );
    expect(render({ limit: 5, reduced: "unconfirmed" })).toContain(
      `20 (up to 5 a day for you across your workspaces not yet paid for until you confirm your email address, then ${OWNER_DAILY_POST_LIMIT})`,
    );
    expect(render({ limit: 5, reduced: "first_day" })).toContain(
      `20 (up to 5 a day for you across your workspaces not yet paid for on your account&#x27;s first day, then ${OWNER_DAILY_POST_LIMIT} from 00:00 UTC)`,
    );
    for (const reduced of [null, "unconfirmed", "first_day", "first_day_unconfirmed"] as const) {
      expect(render({ limit: 5, reduced }), String(reduced)).not.toContain("free workspaces");
    }
    for (const reduced of [null, "unconfirmed", "first_day", "first_day_unconfirmed"] as const) {
      expect(render({ limit: 5, reduced }), String(reduced)).not.toContain("all your workspaces");
      expect(render({ limit: 5, reduced }), String(reduced)).not.toContain("all their workspaces");
    }
  });

  // R8 review: no "while free"; the note shows only where the limit applies.
  it("15: each person can send up to 15 a day across all their workspaces", () => {
    const html = render({ limit: OWNER_DAILY_POST_LIMIT, reduced: null });
    expect(html).toContain(`20 (each person can send up to ${OWNER_DAILY_POST_LIMIT} a day across all their workspaces)`);
    expect(html).not.toContain("while free");
  });

  it("5 until the email is confirmed, with the reason", () => {
    expect(render({ limit: 5, reduced: "unconfirmed" })).toContain(
      `20 (up to 5 a day for you across all your workspaces until you confirm your email address, then ${OWNER_DAILY_POST_LIMIT})`,
    );
  });

  it("5 on the account's first UTC day, with the reason", () => {
    expect(render({ limit: 5, reduced: "first_day" })).toContain(
      `20 (up to 5 a day for you across all your workspaces on your account&#x27;s first day, then ${OWNER_DAILY_POST_LIMIT} from 00:00 UTC)`,
    );
  });

  // R10-pages M1: a plan in its card trial, or active before the first invoice is paid.
  it("a plan not yet paid for: until the first payment, with the viewer's own number", () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const html = render({ limit: OWNER_DAILY_POST_LIMIT, reduced: null, untilFirstPayment: true });
    expect(html).toContain(`Until the first payment, posts here count toward your ${OWNER_DAILY_POST_LIMIT} a day.`);
    expect(html).toContain(`across their workspaces not yet paid for)`);
    expect(render({ limit: 5, reduced: "unconfirmed", untilFirstPayment: true })).toContain(
      "Until the first payment, posts here count toward your 5 a day.",
    );
    expect(render({ limit: OWNER_DAILY_POST_LIMIT, reduced: null })).not.toContain("Until the first payment");
    expect(render(null)).not.toContain("Until the first payment");
  });

  it("no note (a paying workspace): the workspace's number alone", () => {
    const html = render(null);
    expect(html).toMatch(/<dd>20<\/dd>/);
    expect(html).not.toContain("a day per person");
    expect(html).not.toContain("for you");
  });
});

// R8-new-customer L4: a workspace made while billing was off keeps posting on the free limits only until it buys a plan.
describe("PlanSection: before the first plan", () => {
  const offers = [{ plan: "starter" as const, name: "Starter", price: "$19 a month" }];
  const LINE = "If you cancel the plan later, this workspace stops posting until it has a plan again.";

  it("no plan and no trial, with the plan buttons: says what cancelling later means", () => {
    const html = renderToStaticMarkup(
      createElement(PlanSection, { workspaceId: "ws-1", label: "Any label", usage: USAGE, offers, noPlanYet: true }),
    );
    expect(html).toContain(LINE);
  });

  it("not flagged, or no plan buttons: no such line, whatever the label", () => {
    for (const props of [
      { label: NO_PLAN_YET_LABEL, offers, noPlanYet: false },
      { label: NO_PLAN_YET_LABEL, offers: [], noPlanYet: true },
    ]) {
      const html = renderToStaticMarkup(createElement(PlanSection, { workspaceId: "ws-1", usage: USAGE, ...props }));
      expect(html).not.toContain(LINE);
    }
  });
});
