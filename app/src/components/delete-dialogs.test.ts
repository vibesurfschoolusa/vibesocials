import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Render every dialog open, so the confirmation's words can be read.
vi.mock("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    Dialog: pass,
    DialogBody: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    ConfirmDialog: () => null,
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }), signOut: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { AccountSection } from "./account-section";
import { TeamSection } from "./team-section";

/** S1 item 8: the delete dialogs say what happens to a paid plan; without one, today's words. */

const WORKSPACE_SENTENCE =
  "This workspace's paid plan is cancelled at once when you delete it. The period you have already paid for is not refunded, except where the law requires it.";
const ACCOUNT_SENTENCE =
  "Paid plans on the workspaces deleted with your account are cancelled at once. The period already paid for is not refunded, except where the law requires it.";

function escaped(text: string): string {
  return renderToStaticMarkup(createElement("span", null, text)).slice(6, -7);
}

function team(paidPlan?: boolean): string {
  return renderToStaticMarkup(
    createElement(TeamSection, {
      role: "owner",
      workspaceName: "Surf Co",
      deletion: { memberCount: 1, scheduledCount: 0, refusal: null, ...(paidPlan === undefined ? {} : { paidPlan }) },
    }),
  );
}

function account(cancelsPaidPlan?: boolean): string {
  return renderToStaticMarkup(
    createElement(AccountSection, {
      email: "owner@example.test",
      hasPassword: true,
      deletion: { deleteWorkspaces: [{ name: "Surf Co", scheduledCount: 0 }], leaveWorkspaces: [], refusal: null },
      ...(cancelsPaidPlan === undefined ? {} : { cancelsPaidPlan }),
    }),
  );
}

describe("delete dialogs and a paid plan", () => {
  it("the workspace dialog says the plan is cancelled at once and what is not refunded", () => {
    expect(team(true)).toContain(escaped(WORKSPACE_SENTENCE));
  });

  it("the workspace dialog without a paid plan is today's", () => {
    expect(team(false)).toBe(team());
    expect(team()).not.toContain("paid plan");
  });

  it("the account dialog says the plans are cancelled at once and what is not refunded", () => {
    expect(account(true)).toContain(escaped(ACCOUNT_SENTENCE));
  });

  it("the account dialog without a paid plan is today's", () => {
    expect(account(false)).toBe(account());
    expect(account()).not.toContain("Paid plans");
  });
});
