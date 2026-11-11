import { beforeEach, describe, expect, it, vi } from "vitest";

const { memberFindManyMock, sendEmailMock } = vi.hoisted(() => ({
  memberFindManyMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { workspaceMember: { findMany: memberFindManyMock } } }));
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));

import { SUPPORT_EMAIL } from "@/lib/siteInfo";

import { buildWorkspacePauseEmail, notifyOwnersOfPauseChange } from "./pauseEmail";

beforeEach(() => {
  memberFindManyMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("buildWorkspacePauseEmail", () => {
  it("says the workspace was paused, why, what that stops and whom to contact", () => {
    const email = buildWorkspacePauseEmail({ kind: "pause", workspaceName: "Surf Co", reason: "Unpaid invoice." });
    expect(email.subject).toBe("Surf Co is paused on Vibe Socials");
    expect(email.html).toContain("<strong>Surf Co</strong> was paused");
    expect(email.html).toContain("Unpaid invoice.");
    expect(email.html).toContain("Scheduled posts that come due while it is paused are not published");
    expect(email.html).toContain(SUPPORT_EMAIL);
  });

  it("says the workspace was resumed and that held posts need a retry", () => {
    const email = buildWorkspacePauseEmail({ kind: "resume", workspaceName: "Surf Co", reason: null });
    expect(email.subject).toBe("Surf Co is active again on Vibe Socials");
    expect(email.html).toContain("<strong>Surf Co</strong> is active again");
    expect(email.html).toContain("Activity");
    expect(email.html).toContain(SUPPORT_EMAIL);
  });

  it("escapes the name and the reason", () => {
    const email = buildWorkspacePauseEmail({ kind: "pause", workspaceName: "<b>x</b>", reason: "<script>" });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<b>x</b>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});

describe("notifyOwnersOfPauseChange", () => {
  it("emails each owner once, keyed to this change", async () => {
    memberFindManyMock.mockResolvedValue([
      { user: { id: "o1", email: "a@example.com" } },
      { user: { id: "o2", email: "b@example.com" } },
    ]);

    await notifyOwnersOfPauseChange({
      actionId: "act-1",
      kind: "pause",
      workspaceId: "ws-1",
      workspaceName: "Surf Co",
      reason: "Abuse.",
    });

    expect(memberFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner" },
      select: { user: { select: { id: true, email: true } } },
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock.mock.calls[0][0].to).toBe("a@example.com");
    expect(sendEmailMock.mock.calls[0][1]).toEqual({ idempotencyKey: "workspace-pause/act-1/o1" });
    expect(sendEmailMock.mock.calls[1][1]).toEqual({ idempotencyKey: "workspace-pause/act-1/o2" });
  });

  it("never throws", async () => {
    memberFindManyMock.mockRejectedValue(new Error("db down"));
    await expect(
      notifyOwnersOfPauseChange({ actionId: "a", kind: "resume", workspaceId: "ws-1", workspaceName: "x", reason: null }),
    ).resolves.toBeUndefined();
  });
});
