import Link from "next/link";
import { Compass } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Branded 404. Replaces Next's stock "404 | This page could not be found.",
 * which rendered inside the app shell with no way back. Uses the same
 * EmptyState as the rest of the app's zero-data views; the root layout's
 * AppShell still supplies the nav for signed-in users, so the link is a
 * fallback rather than the only exit.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 md:px-6 lg:px-8">
      <EmptyState
        icon={<Compass />}
        title="Page not found"
        description="That link doesn't lead anywhere. It may have moved, or the address may have a typo."
        action={
          <Link href="/" className={buttonVariants({ variant: "primary" })}>
            Back to dashboard
          </Link>
        }
      />
    </div>
  );
}
