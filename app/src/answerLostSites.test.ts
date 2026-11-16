import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob/client", () => ({ put: vi.fn() }));

import { CHANGE_MAYBE_SAVED_MESSAGE } from "@/app/admin/workspaces/[id]/admin-controls";
import { CHOICE_MAYBE_CONNECTED_MESSAGE } from "@/app/c/[token]/connect-link-choice";
import { JOIN_MAYBE_JOINED_MESSAGE, acceptInvite } from "@/app/join/[token]/join-view";
import { CLIENT_FILE_MAYBE_ARRIVED_MESSAGE, ClientFileError, sendClientFile } from "@/app/u/[token]/send-file";
import { VERIFY_RESEND_MAYBE_SENT_MESSAGE, resendVerificationEmail } from "@/app/verify-email/verifyOutcome";
import { POSTING_TIMES_MAYBE_SAVED_MESSAGE } from "@/components/posting-slots-form";
import { SETTINGS_MAYBE_SAVED_MESSAGE } from "@/components/settings-form";
import { LOGO_REMOVE_MAYBE_MESSAGE, LOGO_SAVE_MAYBE_MESSAGE, logoFailureText } from "@/lib/workspaceLogo";

/**
 * R28 NN2, second part (lead: convert them all): the presses outside the first
 * list that change data, each with true wording when the answer is lost.
 */
const LEAD = "Vibe Socials' answer didn't reach you, so ";
const read = (path: string) => readFileSync(join(__dirname, path), "utf8");
const offline = vi.fn(async () => {
  throw new TypeError("Failed to fetch");
}) as unknown as typeof fetch;

describe("lost answers outside the first list", () => {
  it("each says what may have happened and where to check", () => {
    expect(CHANGE_MAYBE_SAVED_MESSAGE).toBe(`${LEAD}the change may have been saved. If your connection dropped, reconnect first. Reload the page to see.`);
    expect(CHOICE_MAYBE_CONNECTED_MESSAGE).toBe(
      `${LEAD}the account may have been connected. If your connection dropped, reconnect first. Reload this page to see.`,
    );
    expect(JOIN_MAYBE_JOINED_MESSAGE).toBe(
      `${LEAD}you may have joined. If your connection dropped, reconnect first. Reload this page to see whether you're a member before you press Join workspace again.`,
    );
    expect(CLIENT_FILE_MAYBE_ARRIVED_MESSAGE).toBe(
      `${LEAD}the file may have arrived. If your connection dropped, reconnect first. If you send it again, it may arrive twice.`,
    );
    expect(POSTING_TIMES_MAYBE_SAVED_MESSAGE).toBe(
      `${LEAD}the posting times may have been saved. If your connection dropped, reconnect first. Reload this page to see them.`,
    );
    expect(SETTINGS_MAYBE_SAVED_MESSAGE).toBe(
      `${LEAD}your settings may have been saved. If your connection dropped, reconnect first. Reload this page to see them before you save again.`,
    );
    expect(LOGO_SAVE_MAYBE_MESSAGE).toBe(`${LEAD}the logo may have been saved. If your connection dropped, reconnect first. Reload this page to see it.`);
    expect(LOGO_REMOVE_MAYBE_MESSAGE).toBe(`${LEAD}the logo may have been removed. If your connection dropped, reconnect first. Reload this page to see.`);
  });

  it("Join with no answer", async () => {
    await expect(acceptInvite(offline, "tok")).resolves.toEqual({ kind: "failed", message: JOIN_MAYBE_JOINED_MESSAGE });
  });

  it("a client file whose register answer is lost may have arrived; a lost token request sent nothing", async () => {
    const file = new File(["x"], "a.jpg", { type: "image/jpeg" });
    const input = { token: "t", file, senderName: "", note: "", onProgress: () => {} };
    let calls = 0;
    const deps = {
      prepare: async (f: File) => f,
      put: async () => ({ url: "https://blob.example/a.jpg" }),
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ clientToken: "c", pathname: "p" }), { status: 200 });
        throw new TypeError("Failed to fetch");
      },
    };
    await expect(sendClientFile(input, deps)).rejects.toMatchObject({ kind: "maybe", message: CLIENT_FILE_MAYBE_ARRIVED_MESSAGE });
    const tokenLost = { ...deps, fetch: async () => Promise.reject(new TypeError("Failed to fetch")) };
    const error = await sendClientFile(input, tokenLost).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClientFileError);
    expect((error as ClientFileError).message).toBe("The upload didn't finish. Check your connection and try again.");
  });

  it("the verification resend, on the verify page and both banners, says a link may have been sent", async () => {
    expect((await resendVerificationEmail(offline)).message).toBe(VERIFY_RESEND_MAYBE_SENT_MESSAGE);
    for (const banner of ["components/shell/verify-email-banner.tsx", "components/shell/workspace-paused-banner.tsx"]) {
      const source = read(banner);
      expect(source, banner).toMatch(/await fetchOrNoAnswer\("\/api\/auth\/resend-verification", \{ method: "POST" \}\)/);
      expect(source, banner).toMatch(/isNoAnswer\(caught\) \? VERIFY_RESEND_MAYBE_SENT_MESSAGE : /);
    }
  });

  it("the logo: no answer or an unreadable 5xx may have saved or removed it", () => {
    expect(logoFailureText("POST", 502, null)).toBe(LOGO_SAVE_MAYBE_MESSAGE);
    expect(logoFailureText("DELETE", 504, null)).toBe(LOGO_REMOVE_MAYBE_MESSAGE);
    expect(logoFailureText("POST", 413, null)).toBe("Couldn't save the logo. Nothing was changed. Try again.");
    expect(logoFailureText("POST", 500, { error: "Server sentence." })).toBe("Server sentence.");
    const control = read("components/workspace-logo-control.tsx");
    expect(control).toMatch(/await fetchOrNoAnswer\(logoEndpoint\(workspaceId\)/);
    expect(control).toMatch(/catch \(caught\) \{\s+setError\(isNoAnswer\(caught\) \? \(method === "POST" \? LOGO_SAVE_MAYBE_MESSAGE : LOGO_REMOVE_MAYBE_MESSAGE\) : fallback\);/);
  });

  it("settings and posting times word a lost answer as may have been saved", () => {
    expect(read("components/settings-form.tsx")).toMatch(/isNoAnswer\(caught\) \? SETTINGS_MAYBE_SAVED_MESSAGE : /);
    expect(read("components/posting-slots-form.tsx")).toMatch(/isNoAnswer\(caught\) \? POSTING_TIMES_MAYBE_SAVED_MESSAGE : /);
    expect(read("app/admin/workspaces/[id]/admin-controls.tsx")).toMatch(/isNoAnswer\(caught\) \? CHANGE_MAYBE_SAVED_MESSAGE : /);
    expect(read("app/c/[token]/connect-link-choice.tsx")).toMatch(/isNoAnswer\(caught\) \? CHOICE_MAYBE_CONNECTED_MESSAGE : /);
  });

  // Lead review: an unreadable 5xx may come after the save, as a lost answer may.
  it("an unreadable 5xx after the file reached storage may have saved it", async () => {
    const media = read("components/media-library.tsx");
    expect(media).toMatch(/toast\.error\(mediaSaveFailureText\(response\.status, data as \{ error\?: string \} \| null\)\);/);
    const { mediaSaveFailureText, MEDIA_MESSAGES } = await import("@/components/media-library");
    expect(mediaSaveFailureText(502, null)).toBe(MEDIA_MESSAGES.saveLost);
    expect(mediaSaveFailureText(400, null)).toBe(MEDIA_MESSAGES.uploadFailed);
    expect(mediaSaveFailureText(409, { error: "Switched workspace." })).toBe("Switched workspace.");

    const file = new File(["x"], "a.jpg", { type: "image/jpeg" });
    const input = { token: "t", file, senderName: "", note: "", onProgress: () => {} };
    let calls = 0;
    const deps = {
      prepare: async (f: File) => f,
      put: async () => ({ url: "https://blob.example/a.jpg" }),
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ clientToken: "c", pathname: "p" }), { status: 200 })
          : new Response("<html>Bad gateway</html>", { status: 502 });
      },
    };
    await expect(sendClientFile(input, deps)).rejects.toMatchObject({ kind: "maybe", message: CLIENT_FILE_MAYBE_ARRIVED_MESSAGE });
  });

  // Lead review 3: Add many's caption and Create's Adapt are AI writes too.
  it("Add many's caption and Create's Adapt say the AI's answer isn't shown when it is lost", async () => {
    const { BULK_CAPTION_LOST_TEXT } = await import("@/app/posts/bulk/bulkExtras");
    expect(BULK_CAPTION_LOST_TEXT).toBe(
      `${LEAD}the caption isn't shown. If your connection dropped, reconnect first. Nothing was saved; ask again, or write one yourself.`,
    );
    expect(read("app/posts/bulk/bulk-posts-form.tsx")).toMatch(/captionError: isNoAnswer\(error\) \? BULK_CAPTION_LOST_TEXT : captionFailedText\(null, undefined\)/);
    const { adaptLostText } = await import("@/components/composer/platform-caption-editor");
    expect(adaptLostText("LinkedIn")).toBe(
      `${LEAD}the adapted caption for LinkedIn isn't shown. If your connection dropped, reconnect first. Nothing was saved; try again.`,
    );
    expect(read("components/composer/platform-caption-editor.tsx")).toMatch(/isNoAnswer\(caught\) \? adaptLostText\(platformLabel\(platform\)\) : /);
  });
});
