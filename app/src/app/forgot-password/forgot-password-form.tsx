"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Request-a-reset form. Deliberately reveals NOTHING about whether the address
 * has an account (SEC-1 no-oracle): after any submit it shows the SAME uniform
 * confirmation, and it never inspects the response status — even a rate-limit
 * (429) or a network failure lands on the identical message.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      // Swallow: the confirmation below is intentionally uniform, so even a
      // transport error shows the same message. The user can simply retry.
    }
    setSubmitted(true);
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

      <Button type="submit" loading={loading} className="w-full">
        Send reset link
      </Button>
    </form>
  );
}
