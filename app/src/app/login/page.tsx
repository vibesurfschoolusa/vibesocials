"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GoogleSignInButton } from "@/components/google-sign-in-button";

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Sanitize once: only accept an internal path so we never redirect off-site
  // or hit a protocol-relative URL ("//evil.example.com").
  const raw = searchParams.get("callbackUrl");
  const callbackUrl = raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
  const registered = searchParams.get("registered") === "1";
  // NextAuth redirects OAuth failures here as ?error=<code> (pages.signIn for
  // transient OAuth errors, pages.error for AccessDenied refusals). Rendered
  // without the code itself; AccessDenied is deterministic (retrying the same
  // Google account can never succeed — see lib/googleSso.ts refusal rules),
  // so its copy points at the password form instead of "try again". Neither
  // message leaks whether an account exists.
  const oauthError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const result = await signIn("credentials", {
      redirect: false,
      email,
      password,
    });

    if (result?.ok) {
      router.push(callbackUrl);
      return;
    }
    setError("Invalid email or password.");
    setLoading(false);
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4 py-16">
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
            <span
              aria-hidden
              className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-lg font-bold text-white shadow-lg"
            >
              VS
            </span>
          </Link>
        </div>

        <Card>
          <CardHeader>
            <h1 className="text-2xl font-semibold leading-none tracking-tight text-foreground">
              Log in
            </h1>
            <CardDescription>Welcome back to Vibe Socials</CardDescription>
          </CardHeader>
          <CardContent>
            {registered ? (
              <Alert variant="success" className="mb-4">
                Account created — sign in below.
              </Alert>
            ) : null}
            {oauthError && !error ? (
              <Alert variant="danger" className="mb-4">
                {oauthError === "AccessDenied"
                  ? "We couldn't sign you in with that Google account — use your email and password below instead."
                  : "Sign-in didn't complete. Please try again."}
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
                href={callbackUrl === "/" ? "/register" : `/register?callbackUrl=${encodeURIComponent(callbackUrl)}`}
                className="font-semibold text-primary outline-none hover:underline focus-visible:underline"
              >
                Create one
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
