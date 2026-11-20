import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const confirmProps: Record<string, unknown>[] = [];
vi.mock("@/components/ui/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/dialog")>();
  const pass = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    ...actual,
    Dialog: pass,
    DialogBody: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    ConfirmDialog: (props: Record<string, unknown>) => {
      confirmProps.push(props);
      return null;
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }), signOut: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { answerLostText } from "@/lib/answerLost";

import {
  CLIENT_LINKS_MAYBE_OFF_MESSAGE,
  CLIENT_LINKS_MAYBE_REPLACED_MESSAGE,
  INVITE_MAYBE_REVOKED_MESSAGE,
  LEAVE_MAYBE_LEFT_MESSAGE,
  MEMBER_MAYBE_REMOVED_MESSAGE,
  RENAME_MAYBE_SAVED_MESSAGE,
  ROLE_MAYBE_CHANGED_MESSAGE,
  WORKSPACE_MAYBE_DELETED_MESSAGE,
  ClientLinksPanel,
  TeamSection,
  answerFailureText,
  requestClientLinksReplace,
  requestClientLinksTurnOff,
} from "./team-section";

/**
 * R28 NN2 (new-customer L1 L2, client-journey L1, pages L1): every Team card
 * press whose answer is lost says it may have gone through and where to
 * check, never "nothing changed" or "the old links still work".
 */
const LEAD = answerLostText("x", "y").split(" so x.")[0];
const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");

describe("Team card: a lost answer may have gone through", () => {
  it("each text has the shared lead-in and says where to check", () => {
    for (const text of [
      CLIENT_LINKS_MAYBE_REPLACED_MESSAGE,
      CLIENT_LINKS_MAYBE_OFF_MESSAGE,
      INVITE_MAYBE_REVOKED_MESSAGE,
      LEAVE_MAYBE_LEFT_MESSAGE,
      MEMBER_MAYBE_REMOVED_MESSAGE,
      RENAME_MAYBE_SAVED_MESSAGE,
      ROLE_MAYBE_CHANGED_MESSAGE,
      WORKSPACE_MAYBE_DELETED_MESSAGE,
    ]) {
      expect(text.startsWith(LEAD)).toBe(true);
      expect(text).toMatch(/Reload this page/);
    }
    expect(CLIENT_LINKS_MAYBE_REPLACED_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so new client links may have been made, which turns the old ones off. If your connection dropped, reconnect first. Reload this page and copy the links again before you send one: the upload link is on the Media page, the review link on the Queue page and the connect link on this page.",
    );
  });

  // A retry after it went through gets a 409 that isn't the reason.
  it("Leave and Delete workspace say to reload first", () => {
    expect(LEAVE_MAYBE_LEFT_MESSAGE).toMatch(/Reload this page first/);
    expect(WORKSPACE_MAYBE_DELETED_MESSAGE).toMatch(/Reload this page first/);
  });

  it("Make new client links: no answer or an unreadable 5xx may have replaced them, and the other link cards read again", async () => {
    for (const fetchImpl of [
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })),
    ]) {
      const announce = vi.fn();
      await expect(requestClientLinksReplace(fetchImpl as unknown as typeof fetch, "ws-1", announce)).rejects.toThrow(
        CLIENT_LINKS_MAYBE_REPLACED_MESSAGE,
      );
      expect(announce).toHaveBeenCalledTimes(1);
    }
  });

  // R51 client-journey L1: an OK answer that can't be read means the links were
  // replaced, as on Connections, Queue and Media. It throws, so the panel never
  // reads it as "nothing was on" and marks no link off; it reads them again.
  it("Make new client links: an unreadable OK answer may have replaced them, and nothing is read as off", async () => {
    for (const body of ["", "<html>ok</html>", "null", "[]"]) {
      const announce = vi.fn();
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
      await expect(requestClientLinksReplace(fetchImpl as unknown as typeof fetch, "ws-1", announce)).rejects.toThrow(
        CLIENT_LINKS_MAYBE_REPLACED_MESSAGE,
      );
      expect(announce).toHaveBeenCalledTimes(1);
    }
  });

  it("Make new client links: a readable OK answer is returned as it is, and announced", async () => {
    const announce = vi.fn();
    const made = { uploadLink: { url: "u" }, reviewLink: null, connectLink: null };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(made), { status: 200 }));
    await expect(requestClientLinksReplace(fetchImpl as unknown as typeof fetch, "ws-1", announce)).resolves.toEqual(made);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("Turn off: no answer or an unreadable 5xx may have turned them off", async () => {
    for (const fetchImpl of [
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      vi.fn(async () => new Response("", { status: 504 })),
    ]) {
      const announce = vi.fn();
      await expect(requestClientLinksTurnOff(fetchImpl as unknown as typeof fetch, "ws-1", announce)).rejects.toThrow(
        CLIENT_LINKS_MAYBE_OFF_MESSAGE,
      );
      expect(announce).toHaveBeenCalledTimes(1);
    }
  });

  it("a refusal with the route's sentence is shown as it is, and nothing is announced", async () => {
    const announce = vi.fn();
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "Too many." }), { status: 429 }));
    await expect(requestClientLinksReplace(refused as unknown as typeof fetch, "ws-1", announce)).rejects.toThrow("Too many.");
    expect(announce).not.toHaveBeenCalled();
  });

  it("the client links read again after a failed press, so the panel follows", () => {
    for (const name of ["const replaceClientLinks", "const turnOffClientLinks"]) {
      const body = source.slice(source.indexOf(name), source.indexOf("}, [", source.indexOf(name)));
      expect(body).toMatch(/catch \(error\) \{[\s\S]*fetchClientLinks\(workspaceId\)/);
    }
  });

  it("each Team dialog names what may have happened", () => {
    confirmProps.length = 0;
    renderToStaticMarkup(createElement(TeamSection, { workspaceId: "ws-1", role: "owner", workspaceName: "Surf Co" }));
    renderToStaticMarkup(createElement(TeamSection, { workspaceId: "ws-1", role: "member", workspaceName: "Surf Co" }));
    const state = { included: true, on: { upload: true, review: false, connect: false }, connectStopped: false };
    renderToStaticMarkup(createElement(ClientLinksPanel, { state, onReplace: async () => {}, onTurnOff: async () => {} }));
    renderToStaticMarkup(
      createElement(ClientLinksPanel, {
        state: { ...state, included: false },
        onReplace: async () => {},
        onTurnOff: async () => {},
      }),
    );
    const byTitle = (pattern: RegExp) => confirmProps.filter((props) => pattern.test(String(props.title)));
    const expected: Array<[RegExp, string]> = [
      [/^Revoke this invite link\?$/, INVITE_MAYBE_REVOKED_MESSAGE],
      [/^Remove /, MEMBER_MAYBE_REMOVED_MESSAGE],
      [/an owner\?$/, ROLE_MAYBE_CHANGED_MESSAGE],
      [/a member\?$/, ROLE_MAYBE_CHANGED_MESSAGE],
      [/^Leave this workspace\?$/, LEAVE_MAYBE_LEFT_MESSAGE],
      [/^Make new client links\?$/, CLIENT_LINKS_MAYBE_REPLACED_MESSAGE],
      [/^Turn off client links\?$/, CLIENT_LINKS_MAYBE_OFF_MESSAGE],
    ];
    for (const [title, text] of expected) {
      const dialogs = byTitle(title);
      expect(dialogs.length, String(title)).toBeGreaterThan(0);
      for (const dialog of dialogs) expect(dialog.unreachableText, String(title)).toBe(text);
    }
    // Leave is on both views.
    expect(byTitle(/^Leave this workspace\?$/)).toHaveLength(2);
  });

  it("rename and Delete workspace word a lost answer the same way", () => {
    expect(source).toMatch(/confirmFailureText\(error, RENAME_MAYBE_SAVED_MESSAGE\)/);
    const remove = source.slice(source.indexOf("async function handleDelete()"), source.indexOf("return (", source.indexOf("async function handleDelete()")));
    expect(remove).toMatch(/fetchOrNoAnswer\("\/api\/workspaces\/active"/);
    expect(remove).toMatch(/WORKSPACE_MAYBE_DELETED_MESSAGE/);
    expect(remove).not.toMatch(/Could not delete this workspace\. Try again\./);
  });

  // An unreadable 5xx (a gateway's page) may also come after the work was done.
  it("an unreadable 5xx is worded as may have gone through; a refusal keeps its own words", () => {
    expect(answerFailureText(502, null, "maybe", "refused")).toBe("maybe");
    expect(answerFailureText(200, null, "maybe", "refused")).toBe("maybe");
    expect(answerFailureText(403, null, "maybe", "refused")).toBe("refused");
    expect(answerFailureText(500, { error: "Only an owner can do that." }, "maybe", "refused")).toBe("Only an owner can do that.");
    for (const [maybe, refused, times] of [
      ["LEAVE_MAYBE_LEFT_MESSAGE", "Couldn't leave the workspace.", 2],
      ["RENAME_MAYBE_SAVED_MESSAGE", "Couldn't rename workspace.", 1],
      ["INVITE_MAYBE_REVOKED_MESSAGE", "Couldn't revoke the invite link.", 1],
      ["MEMBER_MAYBE_REMOVED_MESSAGE", "Couldn't remove that member.", 1],
      ["ROLE_MAYBE_CHANGED_MESSAGE", "Couldn't update that member's role.", 2],
    ] as const) {
      const call = `toast.error(answerFailureText(response.status, data, ${maybe}, "${refused}"));`;
      expect(source.split(call).length - 1, maybe).toBe(times);
    }
    expect(source).not.toMatch(/toast\.error\(data\?\.error \?\? /);
  });
});
