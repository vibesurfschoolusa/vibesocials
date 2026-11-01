/**
 * Copy for the composer's publish-now confirmation dialog.
 *
 * For a member in a workspace that requires approval the post is only
 * SUBMITTED (server-enforced, 2026-11-01 audit) — telling them "This publishes
 * immediately and can't be undone" would be false, so the dialog says what
 * really happens instead. Everyone else keeps the original confirmation.
 *
 * `lead` renders above the per-platform privacy lines and `trail` below them
 * (null = nothing below).
 */
export interface ComposerConfirmCopy {
  title: string;
  lead: string;
  trail: string | null;
  confirmText: string;
}

export function composerPublishConfirmCopy(input: {
  holdsForApproval: boolean;
  /** Display labels of the selected platforms, in order. */
  platforms: string[];
}): ComposerConfirmCopy {
  const list = input.platforms.join(", ");
  if (input.holdsForApproval) {
    return {
      title: "Submit for approval?",
      lead: `An owner will review this post before it publishes to ${list}.`,
      trail: null,
      confirmText: "Submit for approval",
    };
  }
  const count = input.platforms.length;
  return {
    title: `Publish to ${count} ${count === 1 ? "platform" : "platforms"} now?`,
    lead: list,
    trail: "This publishes immediately and can't be undone here.",
    confirmText: "Publish now",
  };
}
