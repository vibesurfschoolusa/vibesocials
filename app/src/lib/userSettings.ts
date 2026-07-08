/**
 * SEC-1: Browser-safe projection of a User row's caption-settings fields.
 *
 * `User` rows carry secrets (passwordHash) and PII (email, timestamps). Never
 * pass a raw row into a `"use client"` component — the App Router serializes
 * every field into the RSC/HTML payload. Map rows to this type server-side and
 * pass only these display fields.
 *
 * Only add fields here that the client actually renders. Never add
 * passwordHash, email, id, or the raw `User` row.
 */
export interface UserSettings {
  /** Appended to caption footers as "For more info visit [companyWebsite]". */
  companyWebsite: string | null;
  /** Appended to caption footers on a new line after the website. */
  defaultHashtags: string | null;
}
