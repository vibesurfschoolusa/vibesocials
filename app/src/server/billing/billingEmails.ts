import { utcDateLabel } from "@/lib/usageLimits";

/**
 * The three billing emails (21b): a failed card payment, a trial about to end
 * and a trial that ended. Pure builders; the webhook and the reminder job send
 * them through sendEmail. The subject carries the workspace name because an
 * owner can own several workspaces.
 */

/** Same table as limitReachedEmail.ts. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * S1: each email links to Settings, Plan on the app's own address
 * (NEXTAUTH_URL, as the other emails read it). The callers pass nothing, so
 * the address is read here when not given; without one the email keeps its
 * words and has no link.
 */
function planLink(appBaseUrl: string | null | undefined): string | null {
  const base = (appBaseUrl === undefined ? process.env.NEXTAUTH_URL : appBaseUrl)?.trim().replace(/\/+$/, "");
  return base ? `<a href="${escapeHtml(base)}/settings#plan">Open Settings, Plan</a>` : null;
}

function html(lines: string[], appBaseUrl: string | null | undefined): string {
  const link = planLink(appBaseUrl);
  return [...lines, ...(link ? [link] : []), "— Vibe Socials"].map((line) => `<p>${line}</p>`).join("\n");
}

export function buildPaymentFailedEmail(
  params: { workspaceName: string },
  appBaseUrl?: string | null,
): { subject: string; html: string } {
  return {
    subject: `We could not charge your card for ${params.workspaceName}`,
    html: html(
      [
        `We could not charge your card for ${escapeHtml(params.workspaceName)}. Update it under Settings, Plan. Your posts keep going out for 7 days.`,
      ],
      appBaseUrl,
    ),
  };
}

export function buildTrialEndingEmail(
  params: { workspaceName: string; trialEndsAt: Date },
  appBaseUrl?: string | null,
): { subject: string; html: string } {
  return {
    subject: `Your Vibe Socials trial for ${params.workspaceName} ends soon`,
    html: html(
      [
        `<strong>${escapeHtml(params.workspaceName)}</strong>`,
        `Your free trial ends on ${utcDateLabel(params.trialEndsAt)}. Choose a plan under Settings, Plan.`,
      ],
      appBaseUrl,
    ),
  };
}

export function buildTrialEndedEmail(
  params: { workspaceName: string },
  appBaseUrl?: string | null,
): { subject: string; html: string } {
  return {
    subject: `Your Vibe Socials trial for ${params.workspaceName} has ended`,
    html: html(
      [
        `<strong>${escapeHtml(params.workspaceName)}</strong>`,
        "Your free trial has ended. Your scheduled posts are on hold until you choose a plan.",
      ],
      appBaseUrl,
    ),
  };
}
