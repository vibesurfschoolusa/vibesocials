"use client";

import { Suspense, useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { useFreshSignedInAccount } from "@/components/signed-in-swap";
import { loginOAuthErrorMessage } from "@/lib/loginOAuthError";
import { authPageHref, safeCallbackPath } from "@/lib/safeRedirect";

import { FormHeading, SignedInNotice, showSignedInNotice } from "./signed-in-notice";
import { LOGIN_CSRF_MESSAGE, addressWithoutCsrf, signInWithPassword } from "./signInWithPassword";

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Sanitize once: only a same-origin relative path is ever followed (no
  // "//host", "/\host", control characters... — see lib/safeRedirect.ts).
  const callbackUrl = safeCallbackPath(searchParams.get("callbackUrl"));
  const registered = searchParams.get("registered") === "1";
  // NextAuth redirects OAuth failures here as ?error=<code> (pages.signIn for
  // transient OAuth errors, pages.error for AccessDenied refusals), and the
  // Google signIn callback sends a refused password-account link here with
  // its own code. Rendered without the code itself — see
  // lib/loginOAuthError.ts for the copy and why it leaks nothing.
  const oauthErrorMessage = loginOAuthErrorMessage(searchParams.get("error"));
  // R31 follow-up: next-auth's own csrf read failed and it landed here. Read
  // once, so dropping the param below keeps the sentence and what was typed.
  const [csrfRefused] = useState(() => searchParams.get("csrf") === "true");
  useEffect(() => {
    const next = addressWithoutCsrf(window.location.pathname, window.location.search);
    if (next) window.history.replaceState(window.history.state, "", next);
  }, []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // R17-pages L1: a signed-in visitor sees who they are, not this form; R18 L1:
  // once the server's own session says so, not the cached one alone.
  const account = useFreshSignedInAccount();
  // R18-pages L2: after Sign out on the notice, the form's heading takes the focus.
  const [signedOutHere, setSignedOutHere] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const result = await signInWithPassword(signIn, email, password);

    if (result.ok) {
      router.push(callbackUrl);
      return;
    }
    setError(result.error);
    setLoading(false);
  }

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-primary/5 via-background to-background"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
      />

      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Link
            href="/"
            aria-label="Vibe Socials home"
            className="rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <BrandMark className="h-14 w-14 rounded-2xl shadow-lg" />
          </Link>
        </div>

        {account && showSignedInNotice(account, loading) ? (
          <SignedInNotice
            account={account}
            callbackUrl={callbackUrl}
            purpose="login"
            onSignedOut={() => setSignedOutHere(true)}
          />
        ) : (
        <Card>
          <CardHeader>
            <FormHeading focus={signedOutHere}>Log in</FormHeading>
            <CardDescription>Welcome back to Vibe Socials</CardDescription>
          </CardHeader>
          <CardContent>
            {registered ? (
              // Sign-up answers alike for a new and an existing email (no
              // email-existence oracle), so this cannot say which happened.
              <Alert variant="info" className="mb-4">
                If this email is new, your account is ready. If you already had an account, sign in
                with its password or{" "}
                <Link href="/forgot-password" className="font-medium underline underline-offset-2">
                  reset it
                </Link>
                .
              </Alert>
            ) : null}
            {oauthErrorMessage && !error ? (
              <Alert variant="danger" className="mb-4">
                {oauthErrorMessage}
              </Alert>
            ) : null}
            {csrfRefused && !oauthErrorMessage && !error ? (
              <Alert variant="danger" className="mb-4">
                {LOGIN_CSRF_MESSAGE}
              </Alert>
            ) : null}
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
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <Link
                    href="/forgot-password"
                    className="text-sm font-medium text-primary outline-none hover:underline focus-visible:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
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
              </div>

              {error ? <Alert variant="danger">{error}</Alert> : null}

              <Button type="submit" loading={loading} className="w-full">
                Sign in
              </Button>
            </form>

            <GoogleSignInButton callbackUrl={callbackUrl} />

            <p className="mt-6 text-center text-sm text-muted-foreground">
              Need an account?{" "}
              <Link
                href={authPageHref("/register", callbackUrl)}
                className="font-semibold text-primary outline-none hover:underline focus-visible:underline"
              >
                Create one
              </Link>
            </p>
          </CardContent>
        </Card>
        )}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
