"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import type { SignedInAccount } from "@/components/signed-in-swap";
import { signOutChecked, type SignOutCheck } from "@/lib/signOutChecked";

/**
 * R17-pages L1: Log in and Register show who is signed in instead of their
 * form, so nobody makes a second account or swaps accounts by accident. Not
 * while the page's own form is signing someone in: that form goes on to its
 * callbackUrl (an invite's Join page included).
 */
export function showSignedInNotice(account: SignedInAccount | null, submitting: boolean): boolean {
  return Boolean(account) && !submitting;
}

/**
 * Signs out without leaving the page, so the form shows here with the same
 * callbackUrl. R32 new-customer L2: through signOutChecked, so a csrf=true
 * answer or a session still there is a failure, not a silent "done".
 */
export async function signOutHere(signOutFn: () => Promise<SignOutCheck> = signOutChecked): Promise<string | null> {
  const check = await signOutFn();
  return check.ok ? null : check.message;
}

/**
 * R18-pages L2: Sign out replaces this card, and its focused button, with the
 * form, so the page is told and moves the focus to the form's heading.
 */
export async function pressSignOut(
  signOutFn: () => Promise<SignOutCheck>,
  onSignedOut: () => void,
): Promise<string | null> {
  const failed = await signOutHere(signOutFn);
  if (!failed) onSignedOut();
  return failed;
}

/**
 * The form's h1 on Log in and Register. Focusable and focused only when it
 * appears after a Sign out on the notice, so the page's first HTML is unchanged.
 */
export function FormHeading({ focus, children }: { focus: boolean; children?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <h1
      ref={ref}
      tabIndex={focus ? -1 : undefined}
      className="text-2xl font-semibold leading-none tracking-tight text-foreground"
    >
      {children}
    </h1>
  );
}

export function SignedInNotice({
  account,
  callbackUrl,
  purpose,
  onSignedOut = () => undefined,
}: {
  account: SignedInAccount;
  callbackUrl: string;
  purpose: "login" | "register";
  onSignedOut?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = account.email || account.name || "your account";
  return (
    <Card>
      <CardHeader>
        <h1 className="text-2xl font-semibold leading-none tracking-tight text-foreground">
          You&apos;re already signed in
        </h1>
        {/* R18-pages L3: a long address wraps inside the card at 375 px. */}
        <CardDescription className="break-words">You&apos;re signed in as {who}.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {purpose === "register"
            ? "To create a different account, sign out first."
            : "To sign in to a different account, sign out first."}
        </p>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link href={callbackUrl} className={buttonVariants({ variant: "primary" })}>
            {callbackUrl === "/" ? "Go to your dashboard" : "Continue"}
          </Link>
          <Button
            type="button"
            variant="outline"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              // On success the session turns signed out and the page shows its form.
              const failed = await pressSignOut(signOutChecked, onSignedOut);
              setError(failed);
              setBusy(false);
            }}
          >
            Sign out
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
