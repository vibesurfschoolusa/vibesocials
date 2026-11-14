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
  shouldSendPostOutcomeEmail,
  type PostOutcomeResultSummary,
} from "@/server/notifications/postOutcomeEmail";

/** The workspace and caption every built email in these tests is for (F4). */
const WS = { workspaceId: "ws_1", workspaceName: "Surf Co", caption: "Dawn patrol tomorrow at 6" };

/** A PostJob row as deliverPostOutcomeNotification selects it. */
function jobRow<T extends object>(fields: T) {
  return { workspaceId: "ws_1", baseCaption: "Dawn patrol tomorrow at 6", mediaItem: null, workspace: { name: "Surf Co" }, ...fields };
}

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
      platform: true,
      status: true,
      errorCode: true,
      errorMessage: true,
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

  it("passes the idempotency key and throwOnRetryable to sendEmail", async () => {
    sendable();

    await deliverPostOutcomeNotification({
      userId: "user-1",
      postJobId: "job-1",
      idempotencyKey: "post-outcome/run-1",
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ to: "user@example.com" });
    expect(sendEmailMock.mock.calls[0][1]).toEqual({
      idempotencyKey: "post-outcome/run-1",
      throwOnRetryable: true,
    });
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
