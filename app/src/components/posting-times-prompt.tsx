import Link from "next/link";

/**
 * What Create and Add many show beside the date when no posting times are
 * saved. Only an owner can add them (posting-slots-form.tsx is read-only for
 * members), so a member reads who can instead of a link to a card they can't use
 * (R12-pages L2). `isMember` comes from the page's workspace context.
 */
export function SetPostingTimesPrompt({ isMember }: { isMember: boolean }) {
  if (isMember) {
    return <span className="text-sm text-muted-foreground">The workspace owner can add posting times.</span>;
  }
  return (
    <Link
      href="/settings#posting-times"
      className="text-sm font-medium text-primary underline-offset-4 hover:underline"
    >
      Set your posting times
    </Link>
  );
}
