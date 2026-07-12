import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// connectionHealth.test.ts / settings route.test.ts). deliverPostOutcomeNotification
// imports both `@/lib/db` and `@/server/notifications/email` at module scope, so
// both must be mocked before postOutcomeEmail.ts is imported below.
const { findUniqueUserMock, findUniquePostJobMock, sendEmailMock } = vi.hoisted(() => ({
  findUniqueUserMock: vi.fn(),
  findUniquePostJobMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: findUniqueUserMock },
    postJob: { findUnique: findUniquePostJobMock },
  },
}));

vi.mock("@/server/notifications/email", () => ({
  sendEmail: sendEmailMock,
}));

import {
  buildPostOutcomeEmail,
  deliverPostOutcomeNotification,
  shouldSendPostOutcomeEmail,
  type PostOutcomeResultSummary,
} from "@/server/notifications/postOutcomeEmail";

beforeEach(() => {
  findUniqueUserMock.mockReset();
  findUniquePostJobMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("shouldSendPostOutcomeEmail", () => {
  it("is true when the key is configured, the user opted in, and has an email", () => {
    expect(
      shouldSendPostOutcomeEmail({ hasApiKey: true, pref: true, hasEmail: true }),
    ).toBe(true);
  });

  it("is false when RESEND_API_KEY is not configured", () => {
    expect(
      shouldSendPostOutcomeEmail({ hasApiKey: false, pref: true, hasEmail: true }),
    ).toBe(false);
  });

  it("is false when the user's preference is off", () => {
    expect(
      shouldSendPostOutcomeEmail({ hasApiKey: true, pref: false, hasEmail: true }),
    ).toBe(false);
  });

  it("is false when there is no email (including a missing user, folded into hasEmail)", () => {
    expect(
      shouldSendPostOutcomeEmail({ hasApiKey: true, pref: true, hasEmail: false }),
    ).toBe(false);
  });

  it("is false when every gate is closed", () => {
    expect(
      shouldSendPostOutcomeEmail({ hasApiKey: false, pref: false, hasEmail: false }),
    ).toBe(false);
  });
});

describe("buildPostOutcomeEmail", () => {
  const mixedResults: PostOutcomeResultSummary[] = [
    { platform: "tiktok", status: "success", errorMessage: null },
    { platform: "youtube", status: "failed", errorMessage: "Quota exceeded" },
    { platform: "x", status: "success", errorMessage: null },
  ];

  it("reflects a mixed success+failure outcome in the subject", () => {
    const email = buildPostOutcomeEmail({
      results: mixedResults,
      appBaseUrl: null,
      postJobId: "job-1",
    });

    expect(email.subject).toBe("Your post finished: 2 of 3 platforms succeeded");
  });

  it("reflects a mixed success+failure outcome in the html, including the short error", () => {
    const email = buildPostOutcomeEmail({
      results: mixedResults,
      appBaseUrl: null,
      postJobId: "job-1",
    });

    expect(email.html).toContain("TikTok: Succeeded");
    expect(email.html).toContain("X: Succeeded");
    expect(email.html).toContain("YouTube: Failed");
    expect(email.html).toContain("Quota exceeded");
  });

  it("produces an all-succeeded subject when nothing failed", () => {
    const email = buildPostOutcomeEmail({
      results: [
        { platform: "tiktok", status: "success" },
        { platform: "youtube", status: "success" },
      ],
      postJobId: "job-2",
    });

    expect(email.subject).toBe("Your post published successfully to all 2 platforms");
  });

  it("produces an all-failed subject when nothing succeeded", () => {
    const email = buildPostOutcomeEmail({
      results: [
        { platform: "tiktok", status: "failed", errorMessage: "Upload failed" },
      ],
      postJobId: "job-3",
    });

    expect(email.subject).toBe("Your post failed to publish");
  });

  it("includes the Activity link when a base URL is given", () => {
    const email = buildPostOutcomeEmail({
      results: mixedResults,
      appBaseUrl: "https://app.example.com",
      postJobId: "job-1",
    });

    expect(email.html).toContain('href="https://app.example.com/activity"');
  });

  it("omits the Activity link cleanly when no base URL is given (undefined, null, or empty)", () => {
    for (const appBaseUrl of [undefined, null, ""] as const) {
      const email = buildPostOutcomeEmail({ results: mixedResults, appBaseUrl, postJobId: "job-1" });
      expect(email.html).not.toContain("<a href");
      expect(email.html).not.toContain("/activity");
    }
  });

  it("never leaks fields beyond platform/status/errorMessage, even if the input object carries extras", () => {
    // Simulates a caller accidentally passing a wider object (e.g. a raw
    // Prisma row with a token field) — buildPostOutcomeEmail must render
    // field-by-field, never dump the object, so nothing beyond the DTO shape
    // can leak into the email body even at runtime (not just by the type).
    const resultWithSecret: PostOutcomeResultSummary & {
      accessToken: string;
      socialConnectionId: string;
    } = {
      platform: "tiktok",
      status: "success",
      errorMessage: null,
      accessToken: "super-secret-token-value",
      socialConnectionId: "conn-abc-123",
    };

    const email = buildPostOutcomeEmail({
      results: [resultWithSecret],
      appBaseUrl: "https://app.example.com",
      postJobId: "job-1",
    });

    expect(email.html).not.toContain("super-secret-token-value");
    expect(email.html).not.toContain("conn-abc-123");
    expect(email.subject).not.toContain("super-secret-token-value");
  });

  it("does not crash and reports a neutral subject when there are no results", () => {
    const email = buildPostOutcomeEmail({ results: [], postJobId: "job-4" });
    expect(email.subject).toBe("Your post has finished processing");
    expect(email.html).toContain("<ul></ul>");
  });

  // Task 9 (Phase-6 review gap close): a scheduled post that fires with zero
  // eligible connections is marked `failed` with NO PostJobResult rows at
  // all, so — unhandled — it would read as the neutral "finished processing"
  // case above, silently under-reporting a real failure.
  it("produces a distinct couldn't-be-published subject and body for a failed job with zero results", () => {
    const email = buildPostOutcomeEmail({
      results: [],
      status: "failed",
      postJobId: "job-5",
    });

    expect(email.subject).toBe("Your scheduled post couldn't be published");
    expect(email.subject).toContain("couldn't be published");
    expect(email.html).toContain("no connected platforms");
    expect(email.html).toContain("Settings");
    expect(email.html).toContain(
      "This post had no connected platforms when it ran, so nothing was published. Connect a platform in Settings, then create the post again.",
    );
  });

  it("keeps the neutral finished-processing subject for a zero-results job that is NOT failed (e.g. completed)", () => {
    const email = buildPostOutcomeEmail({
      results: [],
      status: "completed",
      postJobId: "job-6",
    });

    expect(email.subject).toBe("Your post has finished processing");
    expect(email.html).toContain("<ul></ul>");
  });
});

describe("deliverPostOutcomeNotification", () => {
  it("is a NO-OP — no DB reads, no email attempted, no throw — when RESEND_API_KEY is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "");

    await expect(
      deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" }),
    ).resolves.toBeUndefined();

    expect(findUniqueUserMock).not.toHaveBeenCalled();
    expect(findUniquePostJobMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends the email when the key is set, the user opted in, and has an email", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
    findUniqueUserMock.mockResolvedValue({
      email: "user@example.com",
      notifyOnPostComplete: true,
    });
    findUniquePostJobMock.mockResolvedValue({
      results: [{ platform: "tiktok", status: "success", externalPostId: "ext-1", errorMessage: null }],
    });

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0][0] as { to: string; subject: string; html: string };
    expect(arg.to).toBe("user@example.com");
    expect(arg.html).toContain("https://app.example.com/activity");
  });

  // Team Workspaces (Task 5, verify-only): the recipient must stay the JOB'S
  // CREATOR (`PostJob.userId`, carried in as this function's `userId` param
  // by the caller — see inngest-functions.ts's `notify-outcome` sendEvent),
  // never some notion of "the workspace owner". deliverPostOutcomeNotification
  // only ever looks up `userId` from the event payload, so a member-created
  // job's outcome mail resolves and addresses the MEMBER's own row.
  it("emails the job's CREATOR — a member-created job emails the member, never the workspace owner", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    // The creator of THIS job is a workspace MEMBER, not the owner.
    findUniqueUserMock.mockResolvedValue({
      email: "member@example.com",
      notifyOnPostComplete: true,
    });
    findUniquePostJobMock.mockResolvedValue({
      status: "completed",
      results: [{ platform: "tiktok", status: "success", errorMessage: null }],
    });

    await deliverPostOutcomeNotification({ userId: "member-1", postJobId: "job-1" });

    expect(findUniqueUserMock).toHaveBeenCalledWith({
      where: { id: "member-1" },
      select: { email: true, notifyOnPostComplete: true },
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0][0] as { to: string };
    expect(arg.to).toBe("member@example.com");
  });

  // Task 9: end-to-end check that the DB `select` actually carries
  // PostJob.status through to buildPostOutcomeEmail — the pure-function unit
  // tests above cover the branch logic, this covers the wiring that makes it
  // reachable from the real `notification.requested` → deliver flow.
  it("sends the couldn't-be-published email for a failed job with zero results (Task 9)", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue({
      email: "user@example.com",
      notifyOnPostComplete: true,
    });
    findUniquePostJobMock.mockResolvedValue({ status: "failed", results: [] });

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0][0] as { subject: string; html: string };
    expect(arg.subject).toBe("Your scheduled post couldn't be published");
    expect(arg.html).toContain("no connected platforms");
    expect(arg.html).toContain("Settings");
  });

  it("does not send when the user's preference is off", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue({
      email: "user@example.com",
      notifyOnPostComplete: false,
    });
    findUniquePostJobMock.mockResolvedValue({ results: [] });

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("does not send and does not throw when the user no longer exists", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue(null);
    findUniquePostJobMock.mockResolvedValue({ results: [] });

    await expect(
      deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" }),
    ).resolves.toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("does not send and does not throw when the post job no longer exists", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue({
      email: "user@example.com",
      notifyOnPostComplete: true,
    });
    findUniquePostJobMock.mockResolvedValue(null);

    await expect(
      deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" }),
    ).resolves.toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("swallows a database error — logs, does not throw", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockRejectedValue(new Error("db down"));
    findUniquePostJobMock.mockResolvedValue({ results: [] });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" }),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("omits the Activity link when NEXTAUTH_URL is not set, without crashing", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NEXTAUTH_URL", "");
    findUniqueUserMock.mockResolvedValue({
      email: "user@example.com",
      notifyOnPostComplete: true,
    });
    findUniquePostJobMock.mockResolvedValue({
      results: [{ platform: "tiktok", status: "success", externalPostId: null, errorMessage: null }],
    });

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0][0] as { html: string };
    expect(arg.html).not.toContain("/activity");
  });
});
