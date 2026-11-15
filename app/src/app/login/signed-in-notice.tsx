"use client";

import { useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import type { SignedInAccount } from "@/components/signed-in-swap";

export const SIGN_OUT_FAILED_MESSAGE = "Couldn't sign you out. Check your internet connection and try again.";

/**
 * R17-pages L1: Log in and Register show who is signed in instead of their
 * form, so nobody makes a second account or swaps accounts by accident. Not
 * while the page's own form is signing someone in: that form goes on to its
 * callbackUrl (an invite's Join page included).
 */
export function showSignedInNotice(account: SignedInAccount | null, submitting: boolean): boolean {
  return Boolean(account) && !submitting;
}

/** Signs out without leaving the page, so the form shows here with the same callbackUrl. */
export async function signOutHere(
  signOutFn: (options: { redirect: false }) => Promise<unknown> = signOut,
): Promise<string | null> {
  try {
    await signOutFn({ redirect: false });
    return null;
  } catch {
    return SIGN_OUT_FAILED_MESSAGE;
  }
}

export function SignedInNotice({
  account,
  callbackUrl,
  purpose,
}: {
  account: SignedInAccount;
  callbackUrl: string;
  purpose: "login" | "register";
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
        <CardDescription>You&apos;re signed in as {who}.</CardDescription>
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
              const failed = await signOutHere();
              // On success the session turns signed out and the page shows its form.
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
