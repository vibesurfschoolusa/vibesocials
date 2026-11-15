import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Signed in again | Vibe Socials",
  robots: { index: false, follow: false },
};

/**
 * R21 GG1 follow-up: where the signed-out line's "Sign in again in a new tab"
 * lands. Landing on the page the person was writing on would open a second,
 * empty copy of it; this says to go back to the first tab, which kept the work
 * and hears of the sign-in (beforeSignIn broadcasts it). Server-gated like the
 * other app pages; it reads no workspace or account data.
 */
export default async function SignedInAgainPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/signed-in-again")}`);
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-16 md:px-6 lg:px-8">
      <div className="flex flex-col items-center justify-center gap-3 rounded-[calc(var(--radius)+0.125rem)] border border-dashed border-border px-6 py-12 text-center">
        <h1 className="text-base font-semibold text-foreground">You&apos;re signed in again</h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          Close this tab and go back to the page you were working on. It kept what you wrote.
        </p>
        <Link href="/" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          Go to the dashboard
        </Link>
      </div>
    </div>
  );
}
