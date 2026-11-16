import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// connectionHealth.test.ts / settings route.test.ts). deliverPostOutcomeNotification
// imports both `@/lib/db` and `@/server/notifications/email` at module scope, so
// both must be mocked before postOutcomeEmail.ts is imported below.
const {
  findUniqueUserMock,
  findUniquePostJobMock,
  findFirstPostJobMock,
  updateManyPostJobMock,
  findUniqueMemberMock,
  sendEmailMock,
} = vi.hoisted(() => ({
  findUniqueUserMock: vi.fn(),
  findUniquePostJobMock: vi.fn(),
  findFirstPostJobMock: vi.fn(),
  updateManyPostJobMock: vi.fn(),
  findUniqueMemberMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: findUniqueUserMock },
    // findFirst: the Story job of a feed job (R5-client-journey L3).
    postJob: { findUnique: findUniquePostJobMock, findFirst: findFirstPostJobMock, updateMany: updateManyPostJobMock },
    // R6-publishing L1: the author must still be a member of the post's workspace.
    workspaceMember: { findUnique: findUniqueMemberMock },
  },
}));

// The real EmailRetryableError / isRetryableEmailError stay: the retryable-error
// rethrow is the behaviour under test.
vi.mock("@/server/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notifications/email")>()),
  sendEmail: sendEmailMock,
}));

import { RetryAfterError } from "inngest";

import { EmailRetryableError } from "@/server/notifications/email";
import {
  buildPostOutcomeEmail,
  deliverPostOutcomeNotification,
  PAIR_EMAIL_WAIT_MS,
  pairPartnerStillToSend,
  SCAN_NOTICE_ONCE_A_DAY_LINE,
  shouldSendPostOutcomeEmail,
  type PostOutcomeResultSummary,
} from "@/server/notifications/postOutcomeEmail";
import { STUCK_IN_PROGRESS_MS } from "@/server/jobs/scheduledScanner";
import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";

const escapeForHtml = (text: string) => text.replace(/'/g, "&#39;");

/** The workspace and caption every built email in these tests is for (F4). */
const WS = { workspaceId: "ws_1", workspaceName: "Surf Co", caption: "Dawn patrol tomorrow at 6" };

/** A PostJob row as deliverPostOutcomeNotification selects it. */
function jobRow<T extends object>(fields: T) {
  return { id: "job-1", workspaceId: "ws_1", baseCaption: "Dawn patrol tomorrow at 6", mediaItem: null, workspace: { name: "Surf Co" }, ...fields };
}

beforeEach(() => {
  findUniqueUserMock.mockReset();
  findUniquePostJobMock.mockReset();
  findFirstPostJobMock.mockReset();
  findFirstPostJobMock.mockResolvedValue(null);
  updateManyPostJobMock.mockReset();
  updateManyPostJobMock.mockResolvedValue({ count: 1 });
  findUniqueMemberMock.mockReset();
  findUniqueMemberMock.mockResolvedValue({ id: "member-row" });
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
  // R27 MM4: what each row of a job the stale sweep closed says, matching what
  // the Activity card shows for it (Retry for a stalled row; check the platform
  // first for one that may already be live).
  describe("rows the stale sweep closed", () => {
    const html = (row: PostOutcomeResultSummary) =>
      buildPostOutcomeEmail({ results: [row], appBaseUrl: null, ...WS }).html;

    it("stalled: never reached the platform; retry it in Activity", () => {
      expect(
        html({
          platform: "instagram",
          status: "failed",
          errorCode: "PUBLISH_STALLED",
          errorMessage: "Publish did not complete (stalled). You can retry this platform.",
        }),
      ).toContain("<li>Instagram: Not sent — publishing stopped before it reached Instagram. Retry it in Activity.</li>");
    });

    it("unconfirmed: the shared sentence, check the platform first", () => {
      const out = html({ platform: "x", status: "failed", errorCode: PUBLISH_UNCONFIRMED_CODE, errorMessage: PUBLISH_UNCONFIRMED_MESSAGE });
      expect(out).toContain(`<li>X: ${escapeForHtml(PUBLISH_UNCONFIRMED_MESSAGE)}</li>`);
      expect(out).not.toContain("Failed —");
    });

    it("a row still pending in a closed job (closed before this fix) names no control it lacks", () => {
      const out = html({ platform: "instagram", status: "pending", notSent: true });
      expect(out).toContain(
        "<li>Instagram: Not sent — publishing stopped before it reached Instagram. Open the post in Activity to see where it stands.</li>",
      );
      expect(out).not.toMatch(/Create|send it again/);
    });
  });

  const mixedResults: PostOutcomeResultSummary[] = [
    { platform: "tiktok", status: "success", errorMessage: null },
    { platform: "youtube", status: "failed", errorMessage: "Quota exceeded" },
    { platform: "x", status: "success", errorMessage: null },
  ];

  it("reflects a mixed success+failure outcome in the subject", () => {
    const email = buildPostOutcomeEmail({
      results: mixedResults,
      appBaseUrl: null,
      ...WS,
    });

    expect(email.subject).toBe("Surf Co: your post finished: 2 of 3 platforms succeeded");
  });

  it("reflects a mixed success+failure outcome in the html, including the short error", () => {
    const email = buildPostOutcomeEmail({
      results: mixedResults,
      appBaseUrl: null,
      ...WS,
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
      ...WS,
    });

    expect(email.subject).toBe("Surf Co: your post published successfully to all 2 platforms");
  });

  it("produces an all-failed subject when nothing succeeded", () => {
    const email = buildPostOutcomeEmail({
      results: [
        { platform: "tiktok", status: "failed", errorMessage: "Upload failed" },
      ],
      ...WS,
    });

    expect(email.subject).toBe("Surf Co: your post failed to publish");
  });

  it("includes the Activity link when a base URL is given", () => {
    const email = buildPostOutcomeEmail({
      results: mixedResults,
      appBaseUrl: "https://app.example.com",
      ...WS,
    });

    expect(email.html).toContain('href="https://app.example.com/go?w=ws_1&amp;to=%2Factivity"');
  });

  it("omits the Activity link cleanly when no base URL is given (undefined, null, or empty)", () => {
    for (const appBaseUrl of [undefined, null, ""] as const) {
      const email = buildPostOutcomeEmail({ results: mixedResults, appBaseUrl, ...WS });
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
      ...WS,
    });

    expect(email.html).not.toContain("super-secret-token-value");
    expect(email.html).not.toContain("conn-abc-123");
    expect(email.subject).not.toContain("super-secret-token-value");
  });

  it("does not crash and reports a neutral subject when there are no results", () => {
    const email = buildPostOutcomeEmail({ results: [], ...WS });
    expect(email.subject).toBe("Surf Co: your post has finished processing");
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
      ...WS,
    });

    expect(email.subject).toBe("Surf Co: your scheduled post couldn't be published");
    expect(email.subject).toContain("couldn't be published");
    // F1 review: the job records no cause (no connection could take it, or our
    // side gave up after 2 h), so the email says what is true for both, like the
    // Activity card, and points at Send again instead of "create it again".
    expect(email.html).toContain(
      "This post was not sent. Open it in Activity and use Send again to try once more.",
    );
    expect(email.html).not.toContain("no connected platforms");
    expect(email.html).not.toContain("create the post again");
  });

  it("keeps the neutral finished-processing subject for a zero-results job that is NOT failed (e.g. completed)", () => {
    const email = buildPostOutcomeEmail({
      results: [],
      status: "completed",
      ...WS,
    });

    expect(email.subject).toBe("Surf Co: your post has finished processing");
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
    findUniquePostJobMock.mockResolvedValue(jobRow({
      results: [{ platform: "tiktok", status: "success", externalPostId: "ext-1", errorMessage: null }],
    }));

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0][0] as { to: string; subject: string; html: string };
    expect(arg.to).toBe("user@example.com");
    expect(arg.html).toContain("https://app.example.com/go?w=ws_1&amp;to=%2Factivity");
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
    findUniquePostJobMock.mockResolvedValue(jobRow({
      status: "completed",
      results: [{ platform: "tiktok", status: "success", errorMessage: null }],
    }));

    await deliverPostOutcomeNotification({ userId: "member-1", postJobId: "job-1" });

    expect(findUniqueUserMock).toHaveBeenCalledWith({
      where: { id: "member-1" },
      select: { email: true, notifyOnPostComplete: true },
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0][0] as { to: string };
    expect(arg.to).toBe("member@example.com");
  });

  // R6-publishing L1: someone removed from the workspace (or who left) is no
  // longer told about its posts; nobody else is emailed in their place.
  it("emails nobody when the author is no longer a member of the post's workspace", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue({ email: "gone@example.com", notifyOnPostComplete: true });
    findUniquePostJobMock.mockResolvedValue(jobRow({
      status: "completed",
      results: [{ platform: "tiktok", status: "success", errorMessage: null }],
    }));
    findUniqueMemberMock.mockResolvedValue(null);

    await deliverPostOutcomeNotification({ userId: "member-1", postJobId: "job-1" });

    expect(findUniqueMemberMock).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "ws_1", userId: "member-1" } },
      select: { id: true, role: true },
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(updateManyPostJobMock).not.toHaveBeenCalled();
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
    findUniquePostJobMock.mockResolvedValue(jobRow({ status: "failed", results: [] }));

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0][0] as { subject: string; html: string };
    expect(arg.subject).toBe("Surf Co: your scheduled post couldn't be published");
    expect(arg.html).toContain("This post was not sent. Open it in Activity and use Send again to try once more.");
  });

  // Pause (2026-11-10): every due post of a paused workspace is failed
  // WORKSPACE_PAUSED; one email per post would flood the owner, who already had
  // the pause email.
  it("does not send for a job whose results were failed because the workspace was paused", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue({ email: "user@example.com", notifyOnPostComplete: true });
    findUniquePostJobMock.mockResolvedValue(jobRow({
      status: "failed",
      results: [
        { platform: "x", status: "failed", errorCode: "WORKSPACE_PAUSED", errorMessage: "Not published: this workspace was paused." },
        { platform: "linkedin", status: "failed", errorCode: "WORKSPACE_PAUSED", errorMessage: "Not published: this workspace was paused." },
      ],
    }));

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(findUniquePostJobMock.mock.calls[0][0].select.results.select).toEqual({
      id: true,
      platform: true,
      status: true,
      errorCode: true,
      errorMessage: true,
      updatedAt: true,
      deferredUntil: true,
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // Fix round 2: a partial retry after a resume must not read as a full
  // success while another platform is still unpublished. Every result is
  // listed as on main, paused ones included; nothing is sent only when every
  // result is a paused failure.
  it("lists every result, paused ones included, when anything else is on the job", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue({ email: "user@example.com", notifyOnPostComplete: true });
    const results = [
      { platform: "instagram", status: "failed", errorCode: "WORKSPACE_PAUSED", errorMessage: "Not published: this workspace was paused." },
      { platform: "linkedin", status: "success", errorCode: null, errorMessage: null },
    ];
    findUniquePostJobMock.mockResolvedValue(jobRow({ status: "completed", results }));

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sent = sendEmailMock.mock.calls[0][0] as { subject: string; html: string };
    // Exactly what main writes for this job.
    const expected = buildPostOutcomeEmail({
      results: results as PostOutcomeResultSummary[],
      status: "completed",
      appBaseUrl: process.env.NEXTAUTH_URL || null,
      ...WS,
    });
    expect(sent.subject).toBe(expected.subject);
    expect(sent.html).toBe(expected.html);
    expect(sent.html).toContain("Instagram");
    expect(sent.html).toContain("Not published: this workspace was paused.");
    expect(sent.subject).not.toMatch(/published successfully/i);
  });

  it("still sends for a failed job with any other error code", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue({ email: "user@example.com", notifyOnPostComplete: true });
    findUniquePostJobMock.mockResolvedValue(jobRow({
      status: "failed",
      results: [{ platform: "x", status: "failed", errorCode: "CONNECTION_GONE", errorMessage: "Gone." }],
    }));

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("does not send when the user's preference is off", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue({
      email: "user@example.com",
      notifyOnPostComplete: false,
    });
    findUniquePostJobMock.mockResolvedValue(jobRow({ results: [] }));

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("does not send and does not throw when the user no longer exists", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue(null);
    findUniquePostJobMock.mockResolvedValue(jobRow({ results: [] }));

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
    findUniquePostJobMock.mockResolvedValue(jobRow({ results: [] }));
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
    findUniquePostJobMock.mockResolvedValue(jobRow({
      results: [{ platform: "tiktok", status: "success", externalPostId: null, errorMessage: null }],
    }));

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0][0] as { html: string };
    expect(arg.html).not.toContain("/activity");
  });
});

// 2026-11-01 scale audit (jobs, notifications): a retryable delivery failure must
// reach the Inngest step so it retries; nothing else may.
describe("deliverPostOutcomeNotification - retryable delivery", () => {
  const sendable = () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue({ email: "user@example.com", notifyOnPostComplete: true });
    findUniquePostJobMock.mockResolvedValue(jobRow({
      status: "completed",
      results: [{ platform: "tiktok", status: "success", errorMessage: null }],
    }));
  };

  // Review 2: the key names the outcome (the job and its publish attempt), not
  // the run that asked, so the publish run, the reconciler, the stale sweep and
  // onFailure announcing one attempt all send under one key: Resend sends once.
  it("keys the email on the job and its publish attempt, and throws on retryable errors", async () => {
    sendable();

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ to: "user@example.com" });
    expect(sendEmailMock.mock.calls[0][1]).toEqual({
      idempotencyKey: "post-outcome/job-1/first",
      throwOnRetryable: true,
    });
  });

  it("two notifications of one attempt (the run's and the reconciler's) share the key: one email", async () => {
    sendable();

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });
    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(sendEmailMock.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
      "post-outcome/job-1/first",
      "post-outcome/job-1/first",
    ]);
  });

  it("a Retry starts a new attempt (retriedAt): a second email under a new key", async () => {
    sendable();
    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });
    const retriedAt = new Date("2026-11-14T13:00:00.000Z");
    findUniquePostJobMock.mockResolvedValue(jobRow({
      status: "completed",
      retriedAt,
      results: [{ platform: "tiktok", status: "success", errorMessage: null }],
    }));
    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect(sendEmailMock.mock.calls[1][1].idempotencyKey).toBe(`post-outcome/job-1/${retriedAt.getTime()}`);
  });

  it("rethrows an EmailRetryableError", async () => {
    sendable();
    const failure = new EmailRetryableError("Resend send failed (status 503)");
    sendEmailMock.mockRejectedValueOnce(failure);

    await expect(
      deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" }),
    ).rejects.toBe(failure);
  });

  it("rethrows a RetryAfterError", async () => {
    sendable();
    const failure = new RetryAfterError("Resend rate limited", 2_000);
    sendEmailMock.mockRejectedValueOnce(failure);

    await expect(
      deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" }),
    ).rejects.toBe(failure);
  });

  it("still swallows any other send error", async () => {
    sendable();
    sendEmailMock.mockRejectedValueOnce(new Error("something else"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" }),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
  });

  it("still swallows a database error", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockRejectedValue(new Error("db down"));
    findUniquePostJobMock.mockResolvedValue(jobRow({ results: [] }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" }),
    ).resolves.toBeUndefined();
  });
});

// F4 (R1 M3): the owner must know which workspace and which post an email is about.
describe("buildPostOutcomeEmail - names the workspace and the post (F4)", () => {
  const results: PostOutcomeResultSummary[] = [{ platform: "x", status: "success" }];

  it("names the workspace in the subject and the body", () => {
    const email = buildPostOutcomeEmail({ results, appBaseUrl: null, ...WS });
    expect(email.subject).toBe("Surf Co: your post published successfully");
    expect(email.html).toContain("<p>In <strong>Surf Co</strong>.</p>");
  });

  it("quotes the first 80 characters of the caption instead of the internal id", () => {
    const caption = `${"a".repeat(80)}TAIL`;
    const email = buildPostOutcomeEmail({ results, appBaseUrl: null, ...WS, caption });
    expect(email.html).toContain(`<p>Caption: ${"a".repeat(80)}…</p>`);
    expect(email.html).not.toContain("TAIL");
    expect(email.html).not.toContain("Reference");
  });

  it("quotes a short caption whole and leaves the line out for an empty one", () => {
    expect(buildPostOutcomeEmail({ results, appBaseUrl: null, ...WS }).html).toContain(
      "<p>Caption: Dawn patrol tomorrow at 6</p>",
    );
    expect(buildPostOutcomeEmail({ results, appBaseUrl: null, ...WS, caption: "  " }).html).not.toContain("Caption:");
  });

  it("escapes the workspace name and the caption", () => {
    const email = buildPostOutcomeEmail({
      results,
      appBaseUrl: null,
      ...WS,
      workspaceName: "<b>Surf</b>",
      caption: "<script>x()</script>",
    });
    expect(email.html).not.toContain("<b>Surf");
    expect(email.html).not.toContain("<script>");
  });

  it("ends with how to turn the email off, linked through /go", () => {
    const email = buildPostOutcomeEmail({ results, appBaseUrl: "https://app.example.com", ...WS });
    expect(email.html).toContain(
      '<p>To stop these emails, turn off &quot;Email me when a post finishes&quot; in <a href="https://app.example.com/go?w=ws_1&amp;to=%2Fsettings%23post-defaults">Settings, Posts and emails</a>.</p>',
    );
  });

  it("puts the same line in the couldn't-be-published email", () => {
    const email = buildPostOutcomeEmail({ results: [], status: "failed", appBaseUrl: null, ...WS });
    expect(email.html).toContain("Settings, Posts and emails");
    expect(email.html).toContain("<p>In <strong>Surf Co</strong>.</p>");
  });
});

describe("deliverPostOutcomeNotification - workspace and caption (F4)", () => {
  it("reads the workspace and the caption, falling back to the media item's caption", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
    findUniqueUserMock.mockResolvedValue({ email: "user@example.com", notifyOnPostComplete: true });
    findUniquePostJobMock.mockResolvedValue(
      jobRow({
        workspaceId: "ws_9",
        workspace: { name: "Kite Club" },
        baseCaption: null,
        mediaItem: { baseCaption: "From the library" },
        status: "completed",
        results: [{ platform: "x", status: "success", errorCode: null, errorMessage: null }],
      }),
    );

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    const select = findUniquePostJobMock.mock.calls[0][0].select;
    expect(select).toMatchObject({
      workspaceId: true,
      baseCaption: true,
      mediaItem: { select: { baseCaption: true } },
      workspace: { select: { name: true } },
    });
    const sent = sendEmailMock.mock.calls[0][0] as { subject: string; html: string };
    expect(sent.subject).toBe("Kite Club: your post published successfully");
    expect(sent.html).toContain("<p>Caption: From the library</p>");
    expect(sent.html).toContain("/go?w=ws_9&amp;to=%2Factivity");
  });
});


// R5-client-journey L3: a "Feed and Story" post is two jobs (the Story job names
// its feed job in storyOfPostJobId). Each sent its own email, and the Story's
// did not say Story. Now one email covers both when they finish within
// PAIR_EMAIL_WAIT_MS of each other; a half whose partner is still publishing
// waits that long (sendNotification sleeps), then sends alone, its rows
// labelled. A pair never ends without an email.
describe("deliverPostOutcomeNotification - a Feed and Story pair", () => {
  const FEED_ID = "job-feed";
  const STORY_ID = "job-story";
  const NOW = new Date("2026-11-14T12:00:00.000Z");
  /** When the feed half finished in these tests. */
  const T0 = new Date(NOW.getTime() - 5 * 60_000);
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const HOUR = 3_600_000;

  const feedJob = (fields: Record<string, unknown> = {}, finishedAt: Date = T0) =>
    jobRow({
      id: FEED_ID,
      status: "completed",
      storyOfPostJobId: null,
      updatedAt: finishedAt,
      publishMetadata: { instagram: { placement: "feed" } },
      results: [
        { id: "r1", platform: "instagram", status: "success", errorCode: null, errorMessage: null, claimRunId: "run-a", updatedAt: finishedAt, deferredUntil: null },
        { id: "r2", platform: "facebook_page", status: "success", errorCode: null, errorMessage: null, claimRunId: "run-a", updatedAt: finishedAt, deferredUntil: null },
      ],
      ...fields,
    });
  const storyResults = (finishedAt: Date) => [
    { id: "r3", platform: "instagram", status: "success", errorCode: null, errorMessage: null, claimRunId: "run-b", updatedAt: finishedAt, deferredUntil: null },
    {
      id: "r4",
      platform: "facebook_page",
      status: "failed",
      errorCode: "X",
      errorMessage: "Facebook refused the video.",
      claimRunId: "run-b",
      updatedAt: finishedAt,
      deferredUntil: null,
    },
  ];
  const storyJob = (fields: Record<string, unknown> = {}, finishedAt: Date = NOW) =>
    jobRow({
      id: STORY_ID,
      status: "completed",
      storyOfPostJobId: FEED_ID,
      updatedAt: finishedAt,
      baseCaption: "Dawn patrol tomorrow at 6",
      publishMetadata: { instagram: { placement: "story" }, facebook: { placement: "story" } },
      results: storyResults(finishedAt),
      ...fields,
    });
  /** The Story half still publishing: its results pending, maybe waiting out a platform limit. */
  const storyPublishing = (deferredUntil: Date | null = null) =>
    storyJob({
      status: "in_progress",
      updatedAt: T0,
      results: storyResults(T0).map((r) => ({ ...r, status: "pending", errorCode: null, errorMessage: null, deferredUntil })),
    });

  /** The two jobs as the database holds them: findUnique by id, findFirst by storyOfPostJobId. */
  function pair(feed: Record<string, unknown> | null, story: Record<string, unknown> | null) {
    findUniquePostJobMock.mockImplementation(async (args: { where: { id: string } }) =>
      args.where.id === FEED_ID ? feed : args.where.id === STORY_ID ? story : null,
    );
    findFirstPostJobMock.mockImplementation(async (args: { where: { storyOfPostJobId?: string } }) =>
      args.where.storyOfPostJobId === FEED_ID ? story : null,
    );
  }
  const sent = (index: number) => sendEmailMock.mock.calls[index][0] as { subject: string; html: string };
  const keyOf = (index: number) => (sendEmailMock.mock.calls[index][1] as { idempotencyKey: string }).idempotencyKey;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue({ email: "user@example.com", notifyOnPostComplete: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits longer than the stuck-run reconciler takes to close a dead run", () => {
    expect(PAIR_EMAIL_WAIT_MS).toBe(3 * HOUR);
    expect(PAIR_EMAIL_WAIT_MS).toBeGreaterThan(STUCK_IN_PROGRESS_MS + 30 * 60_000);
  });

  it("the first half to finish sends nothing and asks to wait until it finished + PAIR_EMAIL_WAIT_MS", async () => {
    pair(feedJob(), storyPublishing());

    const out = await deliverPostOutcomeNotification({ userId: "user-1", postJobId: FEED_ID });

    expect(out).toEqual({ waitUntil: at(PAIR_EMAIL_WAIT_MS).toISOString() });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("NORMAL PAIR: the last half sends ONE email for both, the Story rows labelled, about the feed post", async () => {
    pair(feedJob(), storyJob());

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sent(0).subject).toBe("Surf Co: your post and Story finished: 3 of 4 succeeded");
    expect(sent(0).html).toContain(
      "<ul><li>Instagram: Succeeded</li><li>Facebook Page: Succeeded</li><li>Instagram Story: Succeeded</li><li>Facebook Page Story: Failed — Facebook refused the video.</li></ul>",
    );
    expect(sent(0).html).toContain("<p>Caption: Dawn patrol tomorrow at 6</p>");
  });

  it("NORMAL PAIR, replayed: the first half's delivery after its wait sends under the pair's key too, so Resend delivers it once", async () => {
    pair(feedJob(), storyJob());
    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });
    vi.setSystemTime(at(PAIR_EMAIL_WAIT_MS));
    await deliverPostOutcomeNotification({
      userId: "user-1",
      postJobId: FEED_ID,
      afterPairWait: true,
    });
    // And a replay of the same step.
    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

    expect(sendEmailMock).toHaveBeenCalledTimes(3);
    expect(new Set([keyOf(0), keyOf(1), keyOf(2)]).size).toBe(1);
    expect(keyOf(0)).toBe("post-outcome-pair/job-feed/first/first");
    expect(sent(1).subject).toBe(sent(0).subject);
  });

  it("a retry with a new outcome is a new email (a different key)", async () => {
    pair(feedJob(), storyJob());
    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });
    const retried = storyResults(NOW);
    pair(
      feedJob(),
      storyJob({ retriedAt: NOW, results: [retried[0], { ...retried[1], status: "success", claimRunId: "run-c" }] }),
    );
    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

    expect(keyOf(0)).not.toBe(keyOf(1));
    expect(keyOf(1)).toBe(`post-outcome-pair/job-feed/first/${NOW.getTime()}`);
    expect(sent(1).subject).toBe("Surf Co: your post and Story published successfully");
  });

  // The Story's run died: nothing finishes it until the reconciler closes it
  // about 2 h later and sends its notification (scheduledScanner.ts).
  it("STORY RUN DIES: the reconciler's notification sends one email with both halves; the feed's after-wait sends the same", async () => {
    const closedAt = at(2 * HOUR + 5 * 60_000);
    const closed = storyJob(
      {
        status: "failed",
        results: storyResults(closedAt).map((r) => ({
          ...r,
          status: "failed",
          errorCode: "PUBLISH_UNCONFIRMED",
          errorMessage: "We could not confirm this post.",
        })),
      },
      closedAt,
    );
    pair(feedJob(), closed);
    vi.setSystemTime(closedAt);
    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });
    vi.setSystemTime(at(PAIR_EMAIL_WAIT_MS));
    await deliverPostOutcomeNotification({
      userId: "user-1",
      postJobId: FEED_ID,
      afterPairWait: true,
    });

    expect(sent(0).subject).toBe("Surf Co: your post and Story finished: 2 of 4 succeeded");
    // R27 MM4: an unconfirmed row says the shared sentence (it may already be live).
    expect(sent(0).html).toContain(`<li>Instagram Story: ${escapeForHtml(PUBLISH_UNCONFIRMED_MESSAGE)}</li>`);
    expect(keyOf(0)).toBe(keyOf(1));
  });

  it("after the wait, a partner still publishing is not waited for again: this half sends alone with its own key", async () => {
    pair(feedJob(), storyPublishing());
    vi.setSystemTime(at(PAIR_EMAIL_WAIT_MS));

    const out = await deliverPostOutcomeNotification({
      userId: "user-1",
      postJobId: FEED_ID,
      afterPairWait: true,
    });

    expect(out).toBeUndefined();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sent(0).subject).toBe("Surf Co: your post published successfully to all 2 platforms");
    expect(sent(0).html).not.toContain("Story");
    expect(keyOf(0)).toBe("post-outcome/job-feed/first");
  });

  it("DEFERRED FOR HOURS: a partner waiting out a platform limit past the wait: this half sends alone at once", async () => {
    pair(feedJob(), storyPublishing(at(20 * HOUR)));

    const out = await deliverPostOutcomeNotification({ userId: "user-1", postJobId: FEED_ID });

    expect(out).toBeUndefined();
    expect(sent(0).subject).toBe("Surf Co: your post published successfully to all 2 platforms");
    expect(keyOf(0)).toBe("post-outcome/job-feed/first");
  });

  it("DEFERRED FOR HOURS, then finished: the late half sends alone too (its partner already had its email)", async () => {
    const finishedAt = at(20 * HOUR + 60_000);
    pair(feedJob(), storyJob({}, finishedAt));
    vi.setSystemTime(finishedAt);

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

    expect(sent(0).subject).toBe("Surf Co: your Story finished: 1 of 2 platforms succeeded");
    expect(sent(0).html).not.toContain("<li>Instagram: Succeeded</li>");
    expect(keyOf(0)).toBe("post-outcome/job-story/first");
  });

  it("a short deferral (inside the wait) is waited for", async () => {
    pair(feedJob(), storyPublishing(at(HOUR)));

    const out = await deliverPostOutcomeNotification({ userId: "user-1", postJobId: FEED_ID });

    expect(out).toEqual({ waitUntil: at(PAIR_EMAIL_WAIT_MS).toISOString() });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("a job that is publishing again (a retry took it) sends nothing: that run notifies", async () => {
    pair(feedJob({ status: "in_progress" }), storyJob());

    const out = await deliverPostOutcomeNotification({ userId: "user-1", postJobId: FEED_ID, afterPairWait: true });

    expect(out).toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it.each(["draft", "scheduled", "cancelled"] as const)(
    "a partner that is %s is not waited for: this half sends its own email, Story rows labelled",
    async (status) => {
      pair(feedJob({ status }), storyJob());

      await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(sent(0).subject).toBe("Surf Co: your Story finished: 1 of 2 platforms succeeded");
      expect(sent(0).html).toContain("<li>Instagram Story: Succeeded</li>");
      expect(sent(0).html).not.toContain("<li>Instagram: Succeeded</li>");
      expect(keyOf(0)).toBe("post-outcome/job-story/first");
    },
  );

  it("a partner in another workspace, or gone, is no pair", async () => {
    pair(feedJob({ workspaceId: "ws_other" }), storyJob());
    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });
    pair(null, storyJob());
    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    for (const index of [0, 1]) {
      expect(sent(index).subject).toBe("Surf Co: your Story finished: 1 of 2 platforms succeeded");
    }
  });

  // The 6 h stale sweep fails a job whose run never started: its results stay
  // pending, and its finish is the sweep's write to the job, not their old times.
  it("STALE SWEEP, pair half: the swept Story finished hours after the feed, so it sends alone", async () => {
    const sweptAt = at(6 * HOUR + 30 * 60_000);
    const swept = storyJob({
      status: "failed",
      updatedAt: sweptAt,
      results: storyResults(T0).map((r) => ({ ...r, status: "pending", errorCode: null, errorMessage: null })),
    });
    pair(feedJob(), swept);
    vi.setSystemTime(sweptAt);

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sent(0).html).not.toContain("<li>Instagram: Succeeded</li>");
    expect(sent(0).html).toContain(
      "<li>Instagram Story: Not sent — publishing stopped before it reached Instagram. Open the post in Activity to see where it stands.</li>",
    );
    expect(keyOf(0)).toBe("post-outcome/job-story/first");
  });

  it("STALE SWEEP, single job: one email, its unsent rows say so instead of Pending", async () => {
    pair(
      null,
      jobRow({
        id: STORY_ID,
        status: "failed",
        storyOfPostJobId: null,
        updatedAt: NOW,
        publishMetadata: null,
        results: [{ ...storyResults(T0)[0], status: "pending" }],
      }),
    );

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sent(0).subject).toBe("Surf Co: your post failed to publish");
    expect(sent(0).html).toContain("<li>Instagram: Not sent — publishing stopped before it reached Instagram.");
    expect(sent(0).html).not.toContain("Pending");
  });

  // Review 2: both runs died and each onFailure closed its job and announced it.
  it("BOTH RUNS DIE: the two onFailure notices send one email for the pair (same key)", async () => {
    const interrupted = (r: Record<string, unknown>) => ({
      ...r,
      status: "failed",
      errorCode: "PUBLISH_INTERRUPTED",
      errorMessage: "Publishing was interrupted. Please retry.",
    });
    const feed = feedJob({ status: "failed", results: (feedJob().results as Array<Record<string, unknown>>).map(interrupted) });
    const story = storyJob({ status: "failed", results: storyResults(at(60_000)).map(interrupted) }, at(60_000));
    pair(feed, story);

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: FEED_ID });
    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(keyOf(0)).toBe("post-outcome-pair/job-feed/first/first");
    expect(keyOf(1)).toBe(keyOf(0));
    expect(sent(0).subject).toBe("Surf Co: your post and Story failed to publish");
  });

  // R6-publishing L2: the pair's one email is sent only when neither half has
  // emailed for its current attempt; each job records the email its outcome
  // went out in. These run against rows that keep what is written to them.
  describe("each half's outcome goes out in one email only", () => {
    type Row = Record<string, unknown> & { id: string };
    let rows: Map<string, Row>;
    type UpdateArgs = { where: { id: string; OR?: Array<Record<string, unknown>> }; data: Record<string, unknown> };

    function applyUpdate(args: UpdateArgs) {
      const row = rows.get(args.where.id);
      if (!row) return { count: 0 };
      const matches =
        !args.where.OR ||
        args.where.OR.some((condition) => {
          const [[column, value]] = Object.entries(condition);
          if (value === null) return row[column] === null;
          if (typeof value === "object" && value !== null && "not" in value) {
            return row[column] !== null && row[column] !== (value as { not: unknown }).not;
          }
          return row[column] === value;
        });
      if (!matches) return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    }

    function stored(feed: Record<string, unknown>, story: Record<string, unknown>) {
      rows = new Map<string, Row>([
        [FEED_ID, { outcomeEmailAttempt: null, outcomeEmailKey: null, ...feed, id: FEED_ID }],
        [STORY_ID, { outcomeEmailAttempt: null, outcomeEmailKey: null, ...story, id: STORY_ID }],
      ]);
      findUniquePostJobMock.mockImplementation(async (args: { where: { id: string } }) => {
        const row = rows.get(args.where.id);
        return row ? { ...row } : null;
      });
      findFirstPostJobMock.mockImplementation(async (args: { where: { storyOfPostJobId?: string } }) =>
        args.where.storyOfPostJobId === FEED_ID ? { ...rows.get(STORY_ID)! } : null,
      );
      updateManyPostJobMock.mockImplementation(async (args: UpdateArgs) => applyUpdate(args));
    }

    it("THE REPEAT: the feed emailed alone (its Story was not sending yet); the Story finishing soon after sends alone, without the feed's rows", async () => {
      stored(feedJob(), storyJob({ status: "scheduled" }));
      await deliverPostOutcomeNotification({ userId: "user-1", postJobId: FEED_ID });
      expect(keyOf(0)).toBe("post-outcome/job-feed/first");
      expect(rows.get(FEED_ID)).toMatchObject({ outcomeEmailAttempt: "first", outcomeEmailKey: "post-outcome/job-feed/first" });

      // The Story is published and finishes 5 minutes after the feed.
      Object.assign(rows.get(STORY_ID)!, { status: "completed" });
      await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

      expect(sendEmailMock).toHaveBeenCalledTimes(2);
      expect(keyOf(1)).toBe("post-outcome/job-story/first");
      expect(sent(1).subject).toBe("Surf Co: your Story finished: 1 of 2 platforms succeeded");
      expect(sent(1).html).not.toContain("<li>Instagram: Succeeded</li>");
    });

    it("NORMAL PAIR: both halves record the pair's email, so both deliveries send it under one key", async () => {
      stored(feedJob(), storyJob());
      await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });
      vi.setSystemTime(at(PAIR_EMAIL_WAIT_MS));
      await deliverPostOutcomeNotification({ userId: "user-1", postJobId: FEED_ID, afterPairWait: true });

      const pairKey = "post-outcome-pair/job-feed/first/first";
      expect([keyOf(0), keyOf(1)]).toEqual([pairKey, pairKey]);
      for (const id of [FEED_ID, STORY_ID]) {
        expect(rows.get(id)).toMatchObject({ outcomeEmailAttempt: "first", outcomeEmailKey: pairKey });
      }
    });

    it("a retry of the Story after the pair's email sends the Story alone: the feed's rows went out already", async () => {
      stored(feedJob(), storyJob());
      await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

      const retried = storyResults(NOW);
      Object.assign(rows.get(STORY_ID)!, {
        retriedAt: NOW,
        results: [retried[0], { ...retried[1], status: "success", claimRunId: "run-c" }],
      });
      await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

      expect(keyOf(1)).toBe(`post-outcome/job-story/${NOW.getTime()}`);
      expect(sent(1).subject).toBe("Surf Co: your Story published successfully to all 2 platforms");
    });

    it("RACE: the partner emailed alone after this half read it: this half sends alone and records that", async () => {
      stored(feedJob(), storyJob());
      // The feed's own delivery writes its alone email between this half's read and its claim.
      let first = true;
      updateManyPostJobMock.mockImplementation(async (args: UpdateArgs) => {
        if (first) {
          first = false;
          Object.assign(rows.get(FEED_ID)!, { outcomeEmailAttempt: "first", outcomeEmailKey: "post-outcome/job-feed/first" });
        }
        return applyUpdate(args);
      });

      await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(keyOf(0)).toBe("post-outcome/job-story/first");
      expect(sent(0).html).not.toContain("<li>Instagram: Succeeded</li>");
      expect(rows.get(STORY_ID)).toMatchObject({ outcomeEmailKey: "post-outcome/job-story/first" });
      expect(rows.get(FEED_ID)).toMatchObject({ outcomeEmailKey: "post-outcome/job-feed/first" });
    });

    it("a half whose outcome already went out in the pair's email never sends it again alone", async () => {
      const pairKey = "post-outcome-pair/job-feed/first/first";
      // Both halves are recorded in the pair's email; the feed is now told
      // alone (its partner reads as cancelled).
      stored(
        feedJob({ outcomeEmailAttempt: "first", outcomeEmailKey: pairKey }),
        storyJob({ status: "cancelled", outcomeEmailAttempt: "first", outcomeEmailKey: pairKey }),
      );

      await deliverPostOutcomeNotification({ userId: "user-1", postJobId: FEED_ID });

      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  // R9-publishing L1: the scanner's notice for a half asks first whether the
  // other half is still to be sent; if so it stays quiet and that half's run
  // sends the pair's one email.
  describe("pairPartnerStillToSend", () => {
    const storyNothingToSend = () =>
      storyJob({
        status: "failed",
        results: storyResults(NOW).map((r) => ({
          ...r,
          status: "failed",
          errorCode: "RECONNECT_REQUIRED",
          errorMessage: "Reconnect Instagram in Settings, then retry.",
        })),
      });

    it("is true while the other half is publishing (pending or in progress)", async () => {
      pair(feedJob({ status: "in_progress" }), storyNothingToSend());
      await expect(pairPartnerStillToSend(STORY_ID, NOW)).resolves.toBe(true);
      pair(feedJob({ status: "pending" }), storyNothingToSend());
      await expect(pairPartnerStillToSend(STORY_ID, NOW)).resolves.toBe(true);
    });

    it("is true when the other half is scheduled and already due (the same scan sends it)", async () => {
      pair(feedJob({ status: "scheduled", scheduledFor: NOW }), storyNothingToSend());
      await expect(pairPartnerStillToSend(STORY_ID, NOW)).resolves.toBe(true);
    });

    it("is false for a partner scheduled later, finished, held or cancelled, gone, or in another workspace, and for a lone post", async () => {
      pair(feedJob({ status: "scheduled", scheduledFor: new Date(NOW.getTime() + HOUR) }), storyNothingToSend());
      await expect(pairPartnerStillToSend(STORY_ID, NOW)).resolves.toBe(false);
      for (const status of ["completed", "failed", "cancelled", "pending_approval"]) {
        pair(feedJob({ status }), storyNothingToSend());
        await expect(pairPartnerStillToSend(STORY_ID, NOW)).resolves.toBe(false);
      }
      pair(feedJob({ status: "in_progress", workspaceId: "ws_other" }), storyNothingToSend());
      await expect(pairPartnerStillToSend(STORY_ID, NOW)).resolves.toBe(false);
      pair(null, storyNothingToSend());
      await expect(pairPartnerStillToSend(STORY_ID, NOW)).resolves.toBe(false);
      pair(feedJob(), null);
      await expect(pairPartnerStillToSend(FEED_ID, NOW)).resolves.toBe(false);
    });

    it("looks the other way too: the feed's partner is its Story", async () => {
      pair(feedJob({ status: "failed" }), storyPublishing());
      await expect(pairPartnerStillToSend(FEED_ID, NOW)).resolves.toBe(true);
    });

    it("is false when the other half waits out a platform limit past the pair wait (it would never share the email)", async () => {
      pair(feedJob({ status: "failed" }), storyPublishing(new Date(NOW.getTime() + PAIR_EMAIL_WAIT_MS + HOUR)));
      await expect(pairPartnerStillToSend(FEED_ID, NOW)).resolves.toBe(false);
    });

    it("STORY NOTHING TO SEND WHILE THE FEED PUBLISHES: the feed's run then sends one email with both halves", async () => {
      pair(feedJob(), storyNothingToSend());

      await deliverPostOutcomeNotification({ userId: "user-1", postJobId: FEED_ID });

      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(keyOf(0)).toBe("post-outcome-pair/job-feed/first/first");
      expect(sent(0).html).toContain("<li>Instagram: Succeeded</li>");
      expect(sent(0).html).toContain("<li>Instagram Story: Failed — Reconnect Instagram in Settings, then retry.</li>");
    });
  });

  it("a Story-only post (no pair) labels its rows too", async () => {
    pair(null, storyJob({ storyOfPostJobId: null, results: [storyResults(NOW)[0]] }));

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: STORY_ID });

    expect(sent(0).subject).toBe("Surf Co: your Story published successfully");
    expect(sent(0).html).toContain("<li>Instagram Story: Succeeded</li>");
  });
});

// R9-pages L6 / client-journey L2: the scanner sends one such email a day.
describe("buildPostOutcomeEmail - the scanner's once-a-day notice", () => {
  const failed: PostOutcomeResultSummary[] = [{ platform: "x", status: "failed", errorMessage: "Limit." }];

  it("says no other email comes today for the same reason, and where the others are", () => {
    expect(SCAN_NOTICE_ONCE_A_DAY_LINE).toBe(
      "If more posts can't be sent today for the same reason, you won't get another email; Activity lists them.",
    );
    const html = buildPostOutcomeEmail({ results: failed, status: "failed", scanNotice: true, ...WS }).html;
    expect(html).toContain(
      "<p>If more posts can&#39;t be sent today for the same reason, you won&#39;t get another email; Activity lists them.</p>",
    );
    const bare = buildPostOutcomeEmail({ results: [], status: "failed", scanNotice: true, ...WS }).html;
    expect(bare).toContain("you won&#39;t get another email");
  });

  it("is left out of every other outcome email", () => {
    expect(buildPostOutcomeEmail({ results: failed, status: "failed", ...WS }).html).not.toContain("another email");
  });

  it("deliverPostOutcomeNotification adds it only for the scanner's notice", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue({ email: "user@example.com", notifyOnPostComplete: true });
    findUniquePostJobMock.mockResolvedValue(jobRow({ status: "failed", results: [] }));

    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1", afterPairWait: true, scanNotice: true });
    await deliverPostOutcomeNotification({ userId: "user-1", postJobId: "job-1" });

    expect((sendEmailMock.mock.calls[0][0] as { html: string }).html).toContain("you won&#39;t get another email");
    expect((sendEmailMock.mock.calls[1][0] as { html: string }).html).not.toContain("another email");
  });
});

// R9-client-journey L4: only an owner can reconnect, so a member is told who can.
describe("deliverPostOutcomeNotification - reconnect sentence for the recipient", () => {
  const results = [
    {
      platform: "instagram",
      status: "failed",
      errorCode: "RECONNECT_REQUIRED",
      errorMessage: "Reconnect Instagram in Settings, then retry.",
    },
    { platform: "x", status: "failed", errorCode: "X", errorMessage: "X refused it." },
  ];
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    findUniqueUserMock.mockResolvedValue({ email: "user@example.com", notifyOnPostComplete: true });
    findUniquePostJobMock.mockResolvedValue(jobRow({ status: "failed", results }));
  });
  const html = () => (sendEmailMock.mock.calls[0][0] as { html: string }).html;

  it("a member reads that the workspace owner can reconnect it", async () => {
    findUniqueMemberMock.mockResolvedValue({ id: "m", role: "member" });
    await deliverPostOutcomeNotification({ userId: "member-1", postJobId: "job-1" });
    expect(html()).toContain("<li>Instagram: Failed — The workspace owner can reconnect Instagram; then retry.</li>");
    expect(html()).not.toContain("Reconnect Instagram in Settings");
    expect(html()).toContain("<li>X: Failed — X refused it.</li>");
  });

  it("an owner keeps the Settings sentence", async () => {
    findUniqueMemberMock.mockResolvedValue({ id: "m", role: "owner" });
    await deliverPostOutcomeNotification({ userId: "owner-1", postJobId: "job-1" });
    expect(html()).toContain("<li>Instagram: Failed — Reconnect Instagram in Settings, then retry.</li>");
  });

  // R19 publishing L6: the Business Profile location is chosen on an owner-only page.
  it.each([
    ["owner", "Google Business Profile location is not configured. Choose the Business Profile location in Settings, then retry."],
    ["member", "Google Business Profile location is not configured. The workspace owner can choose the Business Profile location; then retry."],
  ] as const)("a Business Profile without a location: the %s's sentence", async (role, expected) => {
    findUniquePostJobMock.mockResolvedValue(
      jobRow({
        status: "failed",
        results: [
          { platform: "google_business_profile", status: "failed", errorCode: "GBP_NO_LOCATION_NAME", errorMessage: "Google Business Profile location is not configured. Choose the Business Profile location in Settings, then retry." },
        ],
      }),
    );
    findUniqueMemberMock.mockResolvedValue({ id: "m", role });
    await deliverPostOutcomeNotification({ userId: `${role}-1`, postJobId: "job-1" });
    expect(html()).toContain(`Failed — ${expected}</li>`);
    if (role === "member") expect(html()).not.toContain("location in Settings");
  });
});
