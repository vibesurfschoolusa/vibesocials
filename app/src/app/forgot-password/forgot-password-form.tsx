"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { forgotPasswordOutcome } from "@/lib/forgotPasswordOutcome";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";

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

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
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
            If an account exists for that address, we sent a reset link.
          </Alert>
        ) : null}
      </div>
      {submitted ? null : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          {error ? <Alert variant="danger">{error}</Alert> : null}

          <Button type="submit" loading={loading} className="w-full">
            Send reset link
          </Button>
        </form>
      )}
    </>
  );
}
