"use client";

import { useRef, useState, type Ref } from "react";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useRetryFocus } from "@/lib/useRetryFocus";

import { undoEmailChange, type UndoView } from "./undoChange";

const HEADING = "text-2xl font-semibold leading-none tracking-tight text-foreground";

/**
 * Posts the link's token (from the URL fragment) only when the person
 * presses the button, so a mail scanner opening the link undoes nothing.
 */
export function UndoClient() {
  const [view, setView] = useState<UndoView | null>(null);
  const [busy, setBusy] = useState(false);
  // R44 pages-a L1: as on the new-address page, a status line says the undo
  // is running, and focus then goes to the answer's heading. While Try again
  // runs, the loading card takes the answer's place, so the same answer twice
  // still mounts anew and is read out.
  const statusRef = useRef<HTMLParagraphElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const pressed = useRetryFocus(busy, statusRef, [resultHeadingRef]);

  async function undo() {
    pressed();
    setBusy(true);
    setView(await undoEmailChange(fetch, window.location.hash.slice(1)));
    setBusy(false);
  }

  return (
    <>
      <p ref={statusRef} role="status" className="sr-only">
        {busy ? "Undoing the email change…" : ""}
      </p>
      {view && busy ? (
        <Card>
          <CardHeader>
            <h1 className={HEADING}>Undoing the email change</h1>
          </CardHeader>
          <CardContent>
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          </CardContent>
        </Card>
      ) : view ? (
        <UndoResult view={view} onRetry={() => void undo()} headingRef={resultHeadingRef} />
      ) : (
        <Card>
          <CardHeader>
            <h1 className={HEADING}>Undo the email change</h1>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Press the button to put your previous sign-in email back. Every device signed in to the account is
              signed out and the password stops working; we then send a password reset link to your previous
              address.
            </p>
            <Button className="mt-4" loading={busy} onClick={() => void undo()}>
              Undo the change
            </Button>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function UndoResult({
  view,
  onRetry,
  headingRef,
}: {
  view: UndoView;
  onRetry: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <Card>
      <CardHeader>
        <h1 ref={headingRef} className={HEADING}>
          {view.title}
        </h1>
      </CardHeader>
      <CardContent>
        <Alert variant={view.undone ? "success" : "danger"}>{view.message}</Alert>
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
