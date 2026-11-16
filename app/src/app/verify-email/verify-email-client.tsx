"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

import { attemptVerify, readAccountState, resendVerificationEmail, verifyView, type VerifyView } from "./verifyOutcome";

function CardShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <h1 className="text-2xl font-semibold leading-none tracking-tight text-foreground">{title}</h1>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * Email-verification landing. The raw token arrives in the URL FRAGMENT
 * (`/verify-email#<token>`), never a query string — so it is never sent to the
 * server on navigation, logged in access logs, or leaked via the Referer header
 * (SEC-1). The fragment is only readable client-side, so it is pulled from
 * `window.location.hash` and POSTed in the request BODY.
 *
 * The POST is fired ONCE on mount (a `useRef` guard makes it survive React
 * StrictMode's double-invoke in development); Try again repeats it only when
 * the link was not used up (no network, server failure). What the page says
 * is decided in ./verifyOutcome.ts.
 */
export function VerifyEmailClient() {
  const [view, setView] = useState<VerifyView | null>(null);
  const [resend, setResend] = useState<{ sending: boolean; result: { ok: boolean; message: string } | null }>({
    sending: false,
    result: null,
  });
  const started = useRef(false);

  // State updates happen inside the async callback, never synchronously in
  // the effect body, so each try resolves to exactly one answer.
  const verify = useCallback(async () => {
    setView(null);
    const attempt = await attemptVerify(fetch, window.location.hash.slice(1));
    // Only a failure needs to know who is reading (lib comment in verifyOutcome.ts).
    const account = attempt === "ok" ? "unknown" : await readAccountState(fetch);
    setView(verifyView(attempt, account));
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void verify();
  }, [verify]);

  async function handleResend() {
    setResend({ sending: true, result: null });
    const result = await resendVerificationEmail(fetch);
    setResend({ sending: false, result });
  }

  if (!view) {
    return (
      <CardShell title="Verifying your email">
        <div className="flex justify-center py-4">
          <Spinner label="Verifying your email" />
        </div>
      </CardShell>
    );
  }

  return <VerifyResult view={view} resend={resend} onResend={handleResend} onRetry={() => void verify()} />;
}

/** The answer card; exported so its markup can be checked without a browser. */
export function VerifyResult({
  view,
  resend,
  onResend,
  onRetry,
}: {
  view: VerifyView;
  resend: { sending: boolean; result: { ok: boolean; message: string } | null };
  onResend: () => void;
  onRetry: () => void;
}) {
  return (
    <CardShell title={view.title}>
      {view.verified ? (
        <Alert variant="success" className="mb-4">
          {view.message}
        </Alert>
      ) : (
        <p role="alert" className="text-sm text-muted-foreground">
          {view.message}
        </p>
      )}
      {/* R28 NN2 (pages L6): on the card from the first render, so "We sent a new link" is announced. */}
      <div role="status" className="empty:sr-only">
        {resend.result?.ok ? (
          <Alert variant="success" role={undefined} className="mt-4">
            {resend.result.message}
          </Alert>
        ) : null}
      </div>
      {resend.result && !resend.result.ok ? (
        <Alert variant="danger" className="mt-4">
          {resend.result.message}
        </Alert>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {view.offerRetry ? (
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        {view.offerResend && !resend.result?.ok ? (
          <Button size="sm" loading={resend.sending} onClick={onResend}>
            Send a new link
          </Button>
        ) : null}
        <Link
          href={view.next.href}
          className="inline-block font-semibold text-primary outline-none hover:underline focus-visible:underline"
        >
          {view.next.label}
        </Link>
      </div>
    </CardShell>
  );
}
