"use client";

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
export function VerifyEmailBanner() {
  const { status } = useSession();
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

  if (!show) return null;

  return (
    <div className="px-4 pt-4 md:px-6">
      <Alert variant="warning" className="items-center p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-foreground">Verify your email — check your inbox.</span>
          <Button size="sm" variant="outline" loading={sending} onClick={handleResend}>
            Resend email
          </Button>
        </div>
      </Alert>
    </div>
  );
}
