"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

import { confirmNewAddress, type NewAddressView } from "./confirmNewAddress";

/**
 * Reads the token from the URL fragment (never sent to a server on
 * navigation, like the verify link) and posts it once on mount; Try again
 * repeats it only when the link was not used up.
 */
export function NewAddressClient() {
  const [view, setView] = useState<NewAddressView | null>(null);
  const started = useRef(false);

  const confirm = useCallback(async () => {
    setView(null);
    const result = await confirmNewAddress(fetch, window.location.hash.slice(1));
    // Every session was signed out on the server; clear this browser's
    // cookie too, so Log in shows the form.
    if (result.changed) await signOut({ redirect: false }).catch(() => undefined);
    setView(result);
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void confirm();
  }, [confirm]);

  if (!view) {
    return (
      <Card>
        <CardHeader>
          <h1 className="text-2xl font-semibold leading-none tracking-tight text-foreground">
            Confirming your new email
          </h1>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center py-4">
            <Spinner label="Confirming your new email" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return <NewAddressResult view={view} onRetry={() => void confirm()} />;
}

/** The answer card; exported so its markup can be checked without a browser. */
export function NewAddressResult({ view, onRetry }: { view: NewAddressView; onRetry: () => void }) {
  return (
    <Card>
      <CardHeader>
        <h1 className="text-2xl font-semibold leading-none tracking-tight text-foreground">{view.title}</h1>
      </CardHeader>
      <CardContent>
        <Alert variant={view.changed ? "success" : "danger"}>{view.message}</Alert>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {view.offerRetry ? (
            <Button size="sm" onClick={onRetry}>
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
