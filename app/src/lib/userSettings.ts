/**
 * SEC-1: browser-safe projection of the settings-page display fields.
 *
 * Despite the name (kept for now — renaming ripples through settings/page.tsx
 * and settings-form.tsx, which is Task 7's full settings-page rework), only
 * `notifyOnPostComplete` is actually a USER-row field as of Team Workspaces.
 * `companyWebsite`/`defaultHashtags` are the caption footer, which moved to
 * the Workspace row (brand-level, owner-only to change — design §2/§4);
 * `settings/page.tsx` sources them from `getWorkspaceContext().workspace`,
 * not `getCurrentUser()`. User-level brand columns were dropped — never read
 * them for display.
 *
 * `User`/`Workspace` rows carry secrets (passwordHash) and PII (email,
 * timestamps). Never pass a raw row into a `"use client"` component — the App
 * Router serializes every field into the RSC/HTML payload. Map rows to this
 * type server-side and pass only these display fields.
 *
 * Only add fields here that the client actually renders. Never add
 * passwordHash, email, id, or a raw `User`/`Workspace` row.
 */
export interface UserSettings {
  /** Appended to caption footers as "For more info visit [companyWebsite]". Sourced from the active Workspace. */
  companyWebsite: string | null;
  /** Appended to caption footers on a new line after the website. Sourced from the active Workspace. */
  defaultHashtags: string | null;
  /**
   * Roadmap Phase 6 — whether to email the user the per-platform outcome when
   * a post job (immediate or a retry) reaches a terminal state. Independent
   * of the RESEND_API_KEY env gate: see server/notifications/postOutcomeEmail.ts.
   * Still a genuine per-user field, sourced from the User row.
   */
  notifyOnPostComplete: boolean;
  /**
   * Approval workflow (2026-07-26) — when true, MEMBERS' posts are held for an
   * owner to approve before anything publishes. Workspace-level and owner-only
   * to change (same class as the footer fields). Sourced from the active
   * Workspace.
   */
  requireApproval: boolean;
}
