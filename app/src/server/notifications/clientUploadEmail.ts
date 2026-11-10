/**
 * Sent to every OWNER of a workspace the first time files arrive through its
 * client upload link in a UTC hour (src/server/uploadLink.ts). Pure builder
 * (tested); transport is the fail-safe sendEmail().
 *
 * The sender's name is typed by whoever has the link, so it is escaped in the
 * HTML like the workspace name. The subject is plain text: the name was already
 * put on one line when it was stored (cleanSenderText in lib/uploadLink.ts).
 */

/** Minimal HTML-entity escaper (same table as reconnectEmail.ts). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildClientUploadEmail(params: {
  senderName: string | null;
  workspaceName: string;
  /** NEXTAUTH_URL; empty gives a relative link. */
  appUrl: string;
}): { subject: string; html: string } {
  const sender = params.senderName ?? "Your client";
  const mediaUrl = `${params.appUrl}/media`;

  return {
    subject: `${sender} sent files to ${params.workspaceName}`,
    html: [
      `<p><strong>${escapeHtml(sender)}</strong> sent files to <strong>${escapeHtml(params.workspaceName)}</strong>. They are in Media.</p>`,
      `<p><a href="${escapeHtml(mediaUrl)}">Open Media</a></p>`,
      `<p>— Vibe Socials</p>`,
    ].join("\n"),
  };
}
