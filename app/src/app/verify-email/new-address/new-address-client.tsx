"use client";

import { useState } from "react";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { signOutChecked } from "@/lib/signOutChecked";

import { confirmNewAddress, type NewAddressView } from "./confirmNewAddress";

/**
 * Posts the link's token (read from the URL fragment, never sent to a server
 * on navigation) only when the person presses the button: a mail scanner
 * that opens the link must not make the change. Try again repeats it only
 * when the link was not used up.
 */
export function NewAddressClient() {
  const [view, setView] = useState<NewAddressView | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    const result = await confirmNewAddress(fetch, window.location.hash.slice(1));
    // Only this account's session: another signed-in account stays signed in.
    // R32 new-customer L2: the checked sign-out (never throws); the server already ended this session.
    if (result.signOutHere) await signOutChecked();
    setView(result);
    setBusy(false);
  }

  if (!view) {
    return (
      <Card>
        <CardHeader>
          <h1 className="text-2xl font-semibold leading-none tracking-tight text-foreground">
            Confirm your new email
          </h1>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Press the button to sign in with this address from now on. Every device signed in to the account is
            signed out.
          </p>
          <Button className="mt-4" loading={busy} onClick={() => void confirm()}>
            Use this email address
          </Button>
        </CardContent>
      </Card>
    );
  }

  return <NewAddressResult view={view} busy={busy} onRetry={() => void confirm()} />;
}

/**
 * The answer card; exported so its markup can be checked without a browser.
 * R29 OO1 (new-customer L3): Try again shows it is working, as the undo page's does.
 */
export function NewAddressResult({
  view,
  busy = false,
  onRetry,
}: {
  view: NewAddressView;
  busy?: boolean;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <h1 className="text-2xl font-semibold leading-none tracking-tight text-foreground">{view.title}</h1>
      </CardHeader>
      <CardContent>
        <Alert variant={view.changed ? "success" : "danger"}>{view.message}</Alert>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {view.offerRetry ? (
            <Button size="sm" loading={busy} onClick={onRetry}>
              Try again
            </Button>
          ) : null}
          <Link
            href={view.next.href}
            className="inline-block font-semibold text-primary outline-none hover:underline focus-visible:underline"
          >
            {view.next.label}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
