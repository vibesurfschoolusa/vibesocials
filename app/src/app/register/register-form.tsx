"use client";

import { Suspense, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { CharacterCount, refuseOverLimit } from "@/components/ui/character-count";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { useFreshSignedInAccount } from "@/components/signed-in-swap";
import { answerLostText } from "@/lib/answerLost";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";
import { authPageHref, safeCallbackPath } from "@/lib/safeRedirect";

import { FormHeading, SignedInNotice, showSignedInNotice } from "../login/signed-in-notice";
import { signInAfterRegister } from "../login/signInWithPassword";

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

/** Counted as the route counts: runs of spaces collapsed, trimmed. */
function collapsedLength(text: string): number {
  return text.replace(/\s+/g, " ").trim().length;
}

/** The route's REGISTER_NAME_MAX_LENGTH (register-form.nameField.live.test.ts ties them). */
export const REGISTER_NAME_MAX_LENGTH = 48;
/** The route's own sentence for a longer name, shown without sending it. */
export const REGISTER_NAME_TOO_LONG_TEXT = `Use a name of up to ${REGISTER_NAME_MAX_LENGTH} characters, or leave it empty.`;

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
  const nameRef = useRef<HTMLInputElement>(null);
  // R17-pages L1: a signed-in visitor sees who they are, not this form; R18 L1:
  // once the server's own session says so, not the cached one alone.
  const account = useFreshSignedInAccount();
  // R18-pages L2: after Sign out on the notice, the form's heading takes the focus.
  const [signedOutHere, setSignedOutHere] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    // R45 new-customer L1: the route counts the network's sign-up try before
    // it checks the name, so a name it would refuse is never sent.
    if (
      refuseOverLimit(
        [
          {
            text: name,
            max: REGISTER_NAME_MAX_LENGTH,
            count: collapsedLength,
            sentence: REGISTER_NAME_TOO_LONG_TEXT,
            field: nameRef.current,
          },
        ],
        setError,
      )
    ) {
      return;
    }
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

    // The account exists now (201 above) whatever happens next. R31 (L1, L4):
    // signInAfterRegister counts the sign-in only when it happened; only a
    // refusal goes to Log in (usually the email already had an account with
    // another password: the 201 is the same either way, and the login page
    // says both). Anything else keeps the form, with what was typed, and its
    // sentence: a page change offline would be the browser's error page.
    const outcome = await signInAfterRegister(signIn, email, password);
    if (outcome.ok) {
      router.push(callbackUrl);
      return;
    }
    if ("toLogin" in outcome) {
      router.push(`/login?registered=1&callbackUrl=${encodeURIComponent(callbackUrl)}`);
      return;
    }
    setError(outcome.error);
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
                  ref={nameRef}
                  id="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-describedby="name-count"
                />
                <CharacterCount
                  id="name-count"
                  label="Name"
                  text={name}
                  count={collapsedLength}
                  max={REGISTER_NAME_MAX_LENGTH}
                  action="create your account"
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
