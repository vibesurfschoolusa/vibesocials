import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "loading" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { readWorkspaceStatus, WorkspaceStatusAlert } from "@/components/shell/workspace-paused-banner";
import { emailUnconfirmedMessage } from "./workspaceStatus";

// R53 fix review L1: the sign-up email can fail without the sign-up failing,
// so the confirm sentence (the shell's banner and every gated route's 403)
// claims no link was sent. Its step names the banner's own button, which
// sits at the top of every signed-in page, beside a 403's own text too.
const WITH_EMAIL =
  "Confirm your email address (new@example.com) to start posting. If the link didn't arrive, press Send the link again at the top of the page.";
const WITHOUT_EMAIL =
  "Confirm your email address to start posting. If the link didn't arrive, press Send the link again at the top of the page.";

describe("emailUnconfirmedMessage", () => {
  it("is true whether or not the email went, with and without an address", () => {
    expect(emailUnconfirmedMessage("new@example.com")).toBe(WITH_EMAIL);
    expect(emailUnconfirmedMessage("")).toBe(WITHOUT_EMAIL);
    for (const sentence of [WITH_EMAIL, WITHOUT_EMAIL]) expect(sentence).not.toMatch(/we sent/i);
  });

  it("names a button the confirm banner really shows", () => {
    for (const email of ["new@example.com", ""]) {
      const html = renderToStaticMarkup(
        createElement(WorkspaceStatusAlert, {
          status: readWorkspaceStatus({ blockedMessage: emailUnconfirmedMessage(email), emailUnconfirmed: true }),
          sending: false,
          onResend: () => {},
        }),
      ).replace(/&#x27;/g, "'");
      expect(html).toContain(emailUnconfirmedMessage(email));
      const named = /press (.+?) at the top of the page/.exec(emailUnconfirmedMessage(email))?.[1];
      expect(html).toMatch(new RegExp(`<button[^>]*>(<[^>]+>)*${named}<`));
    }
  });
});
