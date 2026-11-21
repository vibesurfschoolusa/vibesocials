"use client";

import { useEffect, useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { focusAfterPress } from "@/lib/focusAfter";
import { forgotPasswordOutcome } from "@/lib/forgotPasswordOutcome";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";

/**
 * R54 pages-a L3: the route answers the same whether or not an email went out,
 * so the confirmation never says a link was sent; it says what to do if none
 * arrives. Its button names the one below it exactly.
 * R55 new-customer L1: each request cancels the unused link before it, so
 * only the newest email's link works.
 */
const CONFIRMATION =
  "If an account exists for that address, a reset link is on its way. If it doesn't arrive in a few minutes, check your spam folder, then press Try again. If you get more than one email, use the newest one: only its link works.";

/**
 * Request-a-reset form. Deliberately reveals NOTHING about whether the address
 * has an account (SEC-1 no-oracle): every accepted request shows the SAME
 * uniform confirmation. A rate limit (429), any other failure status, or a
 * network error shows an error instead (see lib/forgotPasswordOutcome.ts) —
 * those depend only on the request, never on whether an account exists.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const tryAgainRef = useRef<HTMLButtonElement>(null);
  // Set by Try again only, so the field is not focused on the first render.
  const focusEmail = useRef(false);

  useEffect(() => {
    if (submitted || !focusEmail.current) return;
    focusEmail.current = false;
    emailRef.current?.focus();
  }, [submitted]);

  function askAgain() {
    focusEmail.current = true;
    setSubmitted(false);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    // R55 fix review: Enter in the email field is the usual path, so the
    // control that had focus is the one watched (submitter would name Send).
    const active = document.activeElement as HTMLElement | null;
    const pressed = active && formRef.current?.contains(active) ? active : sendRef.current;
    setError(null);
    setLoading(true);
    let status: number | null = null;
    let data: { error?: unknown } | null = null;
    try {
      const response = await fetchOrNoAnswer("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      status = response.status;
      data = (await response.json().catch(() => null)) as { error?: unknown } | null;
    } catch {
      // No response at all (network failure): status stays null.
    }
    const outcome = forgotPasswordOutcome(status, data);
    if (outcome.kind === "sent") {
      // R55 pages-a L2: the confirmation replaces the form and its focused
      // button; focus goes to the Try again button it names.
      focusAfterPress(pressed, () => tryAgainRef.current);
      setSubmitted(true);
    } else {
      setError(outcome.message);
    }
    setLoading(false);
  }

  // R28 NN2 (pages L6): on the page from the first render, so the
  // confirmation that replaces the form is announced; only its text changes.
  // R30 PP2: one return, so the line can't be left out of a branch.
  return (
    <>
      <div role="status" className="empty:sr-only">
        {submitted ? (
          <Alert variant="success" role={undefined}>
            {CONFIRMATION}
          </Alert>
        ) : null}
      </div>
      {submitted ? (
        <Button ref={tryAgainRef} type="button" variant="outline" onClick={askAgain} className="mt-4 w-full">
          Try again
        </Button>
      ) : (
        <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              ref={emailRef}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          {error ? <Alert variant="danger">{error}</Alert> : null}

          <Button ref={sendRef} type="submit" loading={loading} className="w-full">
            Send reset link
          </Button>
        </form>
      )}
    </>
  );
}
