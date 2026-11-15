"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/**
 * Soft, dismissable-by-verifying nudge shown at the top of the authenticated
 * chrome when the signed-in user hasn't verified their email AND email is
 * actually configured (so the "Resend" button can do something). It renders
 * NOTHING in every other case — verified users, deployments with email
 * disabled, or while the status is still loading — so it never occupies space
 * or announces itself unnecessarily.
 *
 * REFETCH SEMANTICS (mount-time only, by design): the status is fetched exactly
 * once, the first time the session resolves to "authenticated" after this
 * component mounts (the `fetched` ref guards against React StrictMode's
 * double-invoke and the loading→authenticated transition re-run). There is no
 * live sync — verifying in another tab (or via the /verify-email page) is
 * reflected here only on the NEXT full mount (e.g. a page reload). This is an
 * accepted, documented limitation: the banner is a best-effort reminder, not a
 * source of truth, and the underlying account state is always re-checked
 * server-side on the next request.
 *
 * The fetch is gated on `status === "authenticated"` (not merely on mount)
 * because the app shell can mount this optimistically while the session is still
 * "loading"; fetching then would 401 and wrongly hide the banner with no later
 * retry.
 */
/**
 * Fix round 1 (23): the nudge stays hidden while the workspace banner asks the
 * same person to confirm their address (billing on only), so one person never
 * sees two banners about it. With billing off `suppressed` is never true.
 */
export function verifyEmailBannerShown(accountSaysShow: boolean, suppressed: boolean): boolean {
  return accountSaysShow && !suppressed;
}

/**
 * R8-new-customer L3: the nudge names the address (with billing off it is the
 * only one, and a mistyped address never gets the link) and where to change
 * it, as the workspace banner does (workspace-paused-banner.tsx).
 */
export function VerifyEmailNotice({
  email,
  sending,
  onResend,
}: {
  email: string | null;
  sending: boolean;
  onResend: () => void;
}) {
  return (
    <div className="px-4 pt-4 md:px-6">
      <Alert variant="warning" className="items-center p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* R20 pages L2: the address is one long word; let it break at phone width. */}
          <span className="min-w-0 break-words text-foreground">
            {email ? `Verify your email: we sent a link to ${email}.` : "Verify your email: we sent you a link."}
          </span>
          <Button size="sm" variant="outline" loading={sending} onClick={onResend}>
            Resend email
          </Button>
          <span className="text-foreground">
            Wrong address?{" "}
            <Link href="/settings#account" className="font-medium text-primary underline-offset-4 hover:underline">
              Change it in Settings, Account
            </Link>
            .
          </span>
        </div>
      </Alert>
    </div>
  );
}

export function VerifyEmailBanner({ suppressed = false }: { suppressed?: boolean }) {
  const { status, data: session } = useSession();
  const { success, error } = useToast();
  const [show, setShow] = useState(false);
  const [sending, setSending] = useState(false);
  const fetched = useRef(false);

  useEffect(() => {
    if (status !== "authenticated" || fetched.current) return;
    fetched.current = true;

    void (async () => {
      try {
        const response = await fetch("/api/auth/account-status");
        if (!response.ok) return;
        const data = (await response.json()) as {
          emailVerified?: boolean;
          verificationAvailable?: boolean;
        };
        if (data.emailVerified === false && data.verificationAvailable === true) {
          setShow(true);
        }
      } catch {
        // Best-effort: a failed status probe simply leaves the banner hidden.
      }
    })();
  }, [status]);

  async function handleResend() {
    setSending(true);
    try {
      const response = await fetch("/api/auth/resend-verification", { method: "POST" });
      if (response.ok) {
        success("Verification email sent.");
      } else {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        error(data?.error ?? "Couldn't send the verification email. Please try again.");
      }
    } catch {
      error("Couldn't send the verification email. Please try again.");
    } finally {
      setSending(false);
    }
  }

  if (!verifyEmailBannerShown(show, suppressed)) return null;

  return <VerifyEmailNotice email={session?.user?.email ?? null} sending={sending} onResend={handleResend} />;
}
