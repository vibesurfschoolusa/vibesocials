"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

type VerifyState = "verifying" | "success" | "error";

const SUCCESS_MESSAGE = "Email verified — you're all set.";
const ERROR_MESSAGE =
  "This link is invalid or has expired. Log in and use the resend button to get a fresh one.";

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
 * The POST is fired exactly ONCE on mount (a `useRef` guard makes it survive
 * React StrictMode's double-invoke in development). There is no retry button —
 * a failed or expired link is a terminal state here; the user re-requests a
 * fresh link from the signed-in banner's "Resend email" action.
 */
export function VerifyEmailClient() {
  const [state, setState] = useState<VerifyState>("verifying");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    // All state updates happen INSIDE this async callback (never synchronously
    // in the effect body) so the single POST-on-mount reads the fragment and
    // resolves to exactly one terminal state without cascading renders.
    void (async () => {
      const token = window.location.hash.slice(1);
      if (!token) {
        setState("error");
        return;
      }
      try {
        const response = await fetch("/api/auth/verify-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        setState(response.ok ? "success" : "error");
      } catch {
        setState("error");
      }
    })();
  }, []);

  if (state === "verifying") {
    return (
      <CardShell title="Verifying your email">
        <div className="flex justify-center py-4">
          <Spinner label="Verifying your email" />
        </div>
      </CardShell>
    );
  }

  if (state === "success") {
    return (
      <CardShell title="Email verified" description="Thanks for confirming your email address.">
        <Alert variant="success" className="mb-4">
          {SUCCESS_MESSAGE}
        </Alert>
        <Link
          href="/"
          className="inline-block font-semibold text-primary outline-none hover:underline focus-visible:underline"
        >
          Continue to Vibe Socials
        </Link>
      </CardShell>
    );
  }

  return (
    <CardShell title="This link isn't valid" description="We couldn't verify your email from this link.">
      <p className="text-sm text-muted-foreground">{ERROR_MESSAGE}</p>
      <Link
        href="/login"
        className="mt-4 inline-block font-semibold text-primary outline-none hover:underline focus-visible:underline"
      >
        Log in
      </Link>
    </CardShell>
  );
}
