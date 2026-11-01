"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { forgotPasswordOutcome } from "@/lib/forgotPasswordOutcome";

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
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      status = response.status;
    } catch {
      // No response at all (network failure): status stays null.
    }
    const outcome = forgotPasswordOutcome(status);
    if (outcome.kind === "sent") {
      setSubmitted(true);
    } else {
      setError(outcome.message);
    }
    setLoading(false);
  }

  if (submitted) {
    return (
      <Alert variant="success">
        If an account exists for that address, we sent a reset link.
      </Alert>
    );
  }

  return (
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
  );
}
