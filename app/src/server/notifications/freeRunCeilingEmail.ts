import { logger } from "@/lib/logger";
import { parseAdminEmails } from "@/lib/operator";
import { FREE_RUNS_DAILY_CEILING, utcDayKey, utcDayRange } from "@/lib/usageLimits";
import { sendEmail } from "@/server/notifications/email";
import { sendOncePer, sendToEach } from "@/server/notifications/onceADay";

/**
 * R8-security M1: the operator hears the first time on a UTC day that free
 * runs reach FREE_RUNS_DAILY_CEILING, from where the refusal happens
 * (src/server/usage/usageLog.ts), so no Inngest function or step is spent on
 * it. Operator-only: it names the busiest owners by email address, so the
 * addresses go only into the email, never into a log.
 */

/** One owner and their free runs that day. */
export type CeilingOwner = { email: string; runs: number };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildFreeRunCeilingEmail(params: {
  day: Date;
  /** The owners with the most free runs that day, most first (at most 5). */
  topOwners: readonly CeilingOwner[];
}): { subject: string; html: string } {
  const dayKey = utcDayKey(params.day);
  const rows = params.topOwners
    .map((owner) => `<tr><td>${escapeHtml(owner.email)}</td><td>${owner.runs}</td></tr>`)
    .join("\n");
  const table =
    params.topOwners.length > 0
      ? `<p>The owners with the most free posts today:</p>\n<table>\n<tr><th>Owner</th><th>Posts</th></tr>\n${rows}\n</table>`
      : "<p>No owner could be named for today's free posts.</p>";
  return {
    subject: `Vibe Socials reached its daily ceiling of ${FREE_RUNS_DAILY_CEILING} free posts (${dayKey}, UTC)`,
    html: [
      `<p>Free workspaces reached today's ceiling of ${FREE_RUNS_DAILY_CEILING} posts (UTC). Until 00:00 UTC every other free post, retry and Post now is refused with the service's daily-limit sentence. Paying workspaces and yours still post.</p>`,
      table,
      "<p>If one of these looks like abuse, pause its workspace. If they are real customers, the ceiling (FREE_RUNS_DAILY_CEILING in src/lib/usageLimits.ts) can be raised once the Inngest budget allows it.</p>",
      "<p>— Vibe Socials</p>",
    ].join("\n"),
  };
}

/**
 * Emails every operator (ADMIN_EMAILS) once per UTC day. `topOwners` is read
 * only when the email goes. Through sendOnceADay, like the refused-connect
 * email: when the owners cannot be read or no send went, the
 * day's key is let go again so a later refusal tries once more (review of T1,
 * item 2; the per-recipient idempotency key stops a second copy of one that
 * did go). Never throws: the refusal stands either way.
 */
export async function notifyOperatorOfFreeRunCeiling(input: {
  day: Date;
  topOwners: () => Promise<CeilingOwner[]>;
}): Promise<void> {
  const operators = [...parseAdminEmails(process.env.ADMIN_EMAILS)];
  if (operators.length === 0) return;
  const dayKey = utcDayKey(input.day);
  const key = `free-run-ceiling-email:${dayKey}`;
  await sendOncePer(
    { key, resetAt: utcDayRange(input.day).end, keysFrom: utcDayRange(input.day).start, perRecipientKeys: true },
    async (sendStarted) => {
      const email = buildFreeRunCeilingEmail({ day: input.day, topOwners: await input.topOwners() });
      // sendToEach: one operator's failure never stops the next (R39 L3).
      return sendToEach(
        [...operators.entries()],
        ([index, to]) =>
          sendEmail({ to, ...email }, { idempotencyKey: `free-run-ceiling/${dayKey}/${index}`, throwOnRetryable: true }),
        sendStarted,
      );
    },
    // Only the error's name: a message could carry an address, and those are operator-only.
    (error) =>
      logger.error("[usage] Couldn't email the operator about the free-run ceiling (a later refusal tries again)", {
        error: error instanceof Error ? error.name : "unknown",
      }),
  );
}
