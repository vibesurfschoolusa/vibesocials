/**
 * The subset of the posting user that contributes an optional footer to a
 * published caption. Only the fields actually read are modeled here; a full
 * Prisma `User` (or the serialized user passed through Inngest steps) is
 * structurally assignable to this shape.
 */
export interface CaptionFooterUser {
  companyWebsite?: string | null;
  defaultHashtags?: string | null;
}

/**
 * Compose the published caption from a base caption plus the user's optional
 * footer: a "For more info visit <website>" line, then the default hashtags.
 *
 * The segment order and the `\n\n` (blank-line) separators are load-bearing and
 * asserted by captionFooter.test.ts. Each footer segment is omitted when its
 * source field is empty, whitespace-only, null, or undefined. The base caption
 * is always included (trimmed), even when empty.
 */
export function buildCaptionWithFooter(
  baseCaption: string,
  user: CaptionFooterUser,
): string {
  const parts = [baseCaption.trim()];

  if (user.companyWebsite?.trim()) {
    parts.push(`For more info visit ${user.companyWebsite.trim()}`);
  }

  if (user.defaultHashtags?.trim()) {
    parts.push(user.defaultHashtags.trim());
  }

  return parts.join("\n\n");
}
