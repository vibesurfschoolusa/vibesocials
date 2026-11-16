"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
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
import { answerLostText } from "@/lib/answerLost";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";
import { beforeSignIn } from "@/lib/staleSignOut";
import { authPageHref, safeCallbackPath } from "@/lib/safeRedirect";

import { FormHeading, SignedInNotice, showSignedInNotice } from "../login/signed-in-notice";
import { REGISTER_SIGN_IN_UNFINISHED_MESSAGE, signInReachable } from "../login/signInWithPassword";

/**
 * What the page says under the button, as plain strings from the server page:
 * the trial line (null with billing off) and what the person agrees to (F7:
 * shown billing on or off). Strings, not an import of billingTerms.ts, so the
 * draft wording never ships in this client bundle.
 */
export type RegisterBilling = {
  trialLine: string | null;
  agreement: { before: string; terms: string; between: string; privacy: string; after: string };
};

/** What the form says when sign-up didn't go through (R5 pages L8). */
export const REGISTER_FAILED_MESSAGE =
  "We couldn't create your account just now. Nothing was saved. Please try again in a minute.";
/**
 * R28 NN2 (new-customer L2): the account may have been made before the answer
 * was lost or a gateway answered 5xx; signing up again would not make one.
 */
export const REGISTER_MAYBE_CREATED_MESSAGE = answerLostText(
  "your account may have been created",
  "Then press Log in below and use this email and password before you sign up again.",
);

/** What a refused or unreadable sign-up answer says. */
export function registerFailureText(status: number, data: { error?: unknown } | null): string {
  if (typeof data?.error === "string" && data.error) return data.error;
  return status >= 500 ? REGISTER_MAYBE_CREATED_MESSAGE : REGISTER_FAILED_MESSAGE;
}

function RegisterPageInner({ billing }: { billing: RegisterBilling }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Sanitize once: only a same-origin relative path is ever followed (no
  // "//host", "/\host", control characters... — see lib/safeRedirect.ts).
  const callbackUrl = safeCallbackPath(searchParams.get("callbackUrl"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
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

    try {
      const response = await fetchOrNoAnswer("/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password, name }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setError(registerFailureText(response.status, data));
        setLoading(false);
        return;
      }
    } catch {
      setError(REGISTER_MAYBE_CREATED_MESSAGE);
      setLoading(false);
      return;
    }

    // The account exists now (201 above) regardless of what happens next, so
    // auto-sign-in runs in its own try/catch: a network blip here must not
    // land in the block above and show the misleading "no account was
    // created" — it should just fall through to the friendly login
    // handoff below, same as the "signed in but not ok" case.
    // R30: unreachable, signIn would leave for /api/auth/error instead of
    // throwing; the form stays with what was typed and says to log in.
    if (!(await signInReachable())) {
      setError(REGISTER_SIGN_IN_UNFINISHED_MESSAGE);
      setLoading(false);
      return;
    }
    try {
      // EE1 review: waits for a stale sign-out this page already sent, so it can't clear the new cookie.
      const result = await beforeSignIn(() => signIn("credentials", { redirect: false, email, password }));
      if (result?.ok) {
        router.push(callbackUrl);
        return;
      }
    } catch {
      // fall through to the handoff below
    }
    // Sign-in failed: usually the email already had an account with another
    // password (the 201 above is the same either way). The login page says
    // both possibilities without claiming an account was created.
    router.push(`/login?registered=1&callbackUrl=${encodeURIComponent(callbackUrl)}`);
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
            purpose="register"
            onSignedOut={() => setSignedOutHere(true)}
          />
        ) : (
        <Card>
          <CardHeader>
            <FormHeading focus={signedOutHere}>Create an account</FormHeading>
            <CardDescription>Join Vibe Socials today</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">
                  Name <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="name"
                  type="text"
                  autoComplete="name"
                  maxLength={48}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
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
                <Label htmlFor="password">Password</Label>
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

              {error ? <Alert variant="danger">{error}</Alert> : null}

              <Button type="submit" loading={loading} className="w-full">
                Create account
              </Button>

              <div className="space-y-1 text-center text-xs text-muted-foreground">
                {billing.trialLine ? <p>{billing.trialLine}</p> : null}
                <p>
                  {billing.agreement.before}
                  <Link href="/terms" className="underline underline-offset-2 hover:text-foreground">
                    {billing.agreement.terms}
                  </Link>
                  {billing.agreement.between}
                  <Link href="/privacy" className="underline underline-offset-2 hover:text-foreground">
                    {billing.agreement.privacy}
                  </Link>
                  {billing.agreement.after}
                </p>
              </div>
            </form>

            <GoogleSignInButton callbackUrl={callbackUrl} />

            <p className="mt-6 text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link
                href={authPageHref("/login", callbackUrl)}
                className="font-semibold text-primary outline-none hover:underline focus-visible:underline"
              >
                Log in
              </Link>
            </p>
          </CardContent>
        </Card>
        )}
      </div>
    </main>
  );
}

export function RegisterForm({ billing }: { billing: RegisterBilling }) {
  return (
    <Suspense fallback={null}>
      <RegisterPageInner billing={billing} />
    </Suspense>
  );
}
