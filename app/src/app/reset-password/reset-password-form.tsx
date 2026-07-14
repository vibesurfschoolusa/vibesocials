"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

function CardShell({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <h1 className="text-2xl font-semibold leading-none tracking-tight text-foreground">
          {title}
        </h1>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * Choose-a-new-password form. The raw token arrives in the URL FRAGMENT
 * (`/reset-password#<token>`), never a query string — so it is never sent to
 * the server on navigation, logged in access logs, or leaked via the Referer
 * header (SEC-1). The fragment is only readable client-side, so it is pulled
 * from `window.location.hash` in an effect (the page itself prerenders with no
 * token) and POSTed in the request BODY.
 */
export function ResetPasswordForm() {
  const [token, setToken] = useState<string | null>(null);
  const [tokenReady, setTokenReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    setToken(fromHash.length > 0 ? fromHash : null);
    setTokenReady(true);
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // Client-side guards (server re-validates both — defense in depth).
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });

      if (response.ok) {
        setDone(true);
        return;
      }

      const data = await response.json().catch(() => null);
      setError(data?.error ?? "Something went wrong. Please try again.");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // Before the effect resolves the fragment, show a neutral loading state so
  // the prerendered HTML never flashes the "invalid link" card.
  if (!tokenReady) {
    return (
      <CardShell title="Reset your password">
        <div className="flex justify-center py-4">
          <Spinner label="Loading" />
        </div>
      </CardShell>
    );
  }

  if (!token) {
    return (
      <CardShell title="This link isn't valid" description="This password reset link is invalid or has expired.">
        <p className="text-sm text-muted-foreground">
          Request a new link to reset your password.
        </p>
        <Link
          href="/forgot-password"
          className="mt-4 inline-block font-semibold text-primary outline-none hover:underline focus-visible:underline"
        >
          Request a new link
        </Link>
      </CardShell>
    );
  }

  if (done) {
    return (
      <CardShell title="Password updated" description="Your password has been reset.">
        <Alert variant="success" className="mb-4">
          You can now log in with your new password.
        </Alert>
        <Link
          href="/login"
          className="inline-block font-semibold text-primary outline-none hover:underline focus-visible:underline"
        >
          Log in
        </Link>
      </CardShell>
    );
  }

  return (
    <CardShell title="Choose a new password" description="Enter a new password for your account.">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="password">New password</Label>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              minLength={8}
              className="pl-3 pr-10"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showPassword ? (
                <EyeOff aria-hidden className="h-4 w-4" />
              ) : (
                <Eye aria-hidden className="h-4 w-4" />
              )}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">At least 8 characters.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm">Confirm new password</Label>
          <Input
            id="confirm"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>

        {error ? <Alert variant="danger">{error}</Alert> : null}

        <Button type="submit" loading={loading} className="w-full">
          Reset password
        </Button>
      </form>
    </CardShell>
  );
}
