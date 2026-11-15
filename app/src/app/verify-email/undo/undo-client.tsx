"use client";

import { useState } from "react";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

import { undoEmailChange, type UndoView } from "./undoChange";

/**
 * Posts the link's token (from the URL fragment) only when the person
 * presses the button, so a mail scanner opening the link undoes nothing.
 */
export function UndoClient() {
  const [view, setView] = useState<UndoView | null>(null);
  const [busy, setBusy] = useState(false);

  async function undo() {
    setBusy(true);
    setView(await undoEmailChange(fetch, window.location.hash.slice(1)));
    setBusy(false);
  }

  return (
    <Card>
      <CardHeader>
        <h1 className="text-2xl font-semibold leading-none tracking-tight text-foreground">
          {view ? view.title : "Undo the email change"}
        </h1>
      </CardHeader>
      <CardContent>
        {view ? (
          <>
            <Alert variant={view.undone ? "success" : "danger"}>{view.message}</Alert>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {view.offerRetry ? (
                <Button size="sm" loading={busy} onClick={() => void undo()}>
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
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Press the button to put your previous sign-in email back. Every device signed in to the account is
              signed out, and you then reset your password.
            </p>
            <Button className="mt-4" loading={busy} onClick={() => void undo()}>
              Undo the change
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
