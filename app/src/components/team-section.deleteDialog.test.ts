import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// R7-pages L6: the Delete workspace dialog's error must be announced to screen
// readers, like the other forms' errors (FormError, role="alert"). The tests
// run without a DOM, so the dialog's error state is set through useState:
// its only state that starts as null is the error.
const forced = vi.hoisted(() => ({ error: null as string | null }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) =>
      initial === null && forced.error !== null ? [forced.error, () => {}] : actual.useState(initial),
  };
});
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

import { DeleteWorkspace, deleteConfirmMatches, workspaceNameToSave } from "./team-section";

const DELETION = { memberCount: 2, scheduledCount: 0, refusal: null };

function dialog(memberCount = DELETION.memberCount): string {
  return renderToStaticMarkup(
    createElement(DeleteWorkspace, {
      workspaceId: "ws-1",
      workspaceName: "Surf Co",
      deletion: { ...DELETION, memberCount },
    }),
  );
}

afterEach(() => {
  forced.error = null;
});

describe("Delete workspace dialog", () => {
  it("announces its error with role=alert", () => {
    forced.error = "Could not delete this workspace. Try again.";
    expect(dialog()).toMatch(/<p role="alert"[^>]*>Could not delete this workspace\. Try again\.<\/p>/);
  });

  it("has no alert without an error", () => {
    expect(dialog()).not.toContain('role="alert"');
  });

  // R12-client-journey L3: the count includes the owner, so a workspace with
  // only its owner must not read "for all 1 member".
  it("with only the owner, does not say 'for all 1 member'", () => {
    const html = dialog(1);
    expect(html).toContain("This removes the workspace with its connections, media, posts and stats.");
    expect(html).not.toContain("for all");
  });

  it("with two members, says 'for all 2 members'", () => {
    expect(dialog(2)).toContain("This removes the workspace for all 2 members, with its connections, media, posts and stats.");
  });
});

// R23 new-customer L2: HTML shows "Surf  Co" as "Surf Co", so that is what is typed.
describe("workspace names with runs of spaces", () => {
  it("a rename saves the name with spaces collapsed", () => {
    expect(workspaceNameToSave(" Surf  Co ")).toBe("Surf Co");
    expect(workspaceNameToSave("Surf \t\n Co")).toBe("Surf Co");
    expect(workspaceNameToSave("   ")).toBe("");
  });

  it("a name stored with a double space is confirmed by typing it as shown", () => {
    expect(deleteConfirmMatches("Surf Co", "Surf  Co")).toBe(true);
    expect(deleteConfirmMatches("Surf Co", "Surf Co")).toBe(true);
  });

  it("a wrong name is still refused", () => {
    for (const typed of ["Surf", "surf co", "Surf Cot", "SurfCo", ""]) {
      expect(deleteConfirmMatches(typed, "Surf  Co")).toBe(false);
    }
  });
});
