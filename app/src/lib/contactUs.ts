import { SUPPORT_EMAIL } from "./siteInfo";

/**
 * The account menu's "Contact us" (S1): an email to the support address whose
 * subject names the workspace and whose first line carries its id, so the
 * owner can find the workspace the person writes about. Display-only, safe in
 * client components.
 */
export function contactUsHref(workspace: { id: string; name: string } | null): string {
  if (!workspace) return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Vibe Socials help")}`;
  const subject = encodeURIComponent(`Vibe Socials help: ${workspace.name}`);
  const body = encodeURIComponent(`Workspace id: ${workspace.id}\n\n`);
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}
