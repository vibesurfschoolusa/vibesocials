"use client";

import { useEffect, useState } from "react";
import { getProviders } from "next-auth/react";

import { Button } from "@/components/ui/button";
import { useResetOnReturnFromCache } from "@/components/returnFromCache";
import { GOOGLE_NOT_SENT_MESSAGE, GOOGLE_NOT_STARTED_MESSAGE } from "@/app/login/signInWithPassword";
import { googleSignInChecked } from "@/lib/signInChecked";

/**
 * "Continue with Google" for the login/register cards. Renders NOTHING unless
 * the deployment has Google SSO configured (lib/googleSso.ts env gate) — it
 * asks NextAuth's /api/auth/providers once, so no client env plumbing and
 * zero footprint on deployments without SSO (the default today).
 */
export function GoogleSignInButton({ callbackUrl }: { callbackUrl: string }) {
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProviders()
      .then((providers) => {
        if (!cancelled) setAvailable(Boolean(providers?.google));
      })
      .catch(() => {
        // Provider discovery failing must never break the password form.
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Back from Google's consent screen can restore this page from the cache
  // with `loading` still true; the shared rule makes the button usable again.
  useResetOnReturnFromCache(setLoading, false);

  if (!available) return null;

  return (
    <div className="mt-4">
      <div className="flex items-center gap-3" aria-hidden>
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          or
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <Button
        type="button"
        variant="outline"
        loading={loading}
        className="mt-4 w-full gap-2"
        onClick={async () => {
          setLoading(true);
          setError(null);
          // R30, R31: unreachable, or the redirect request failed or was
          // refused: nothing reached Google, so the page says so instead of
          // only stopping the spinner. On success the page leaves for Google.
          const result = await googleSignInChecked(callbackUrl);
          if (!result.ok) {
            setError(result.reason === "not_started" ? GOOGLE_NOT_STARTED_MESSAGE : GOOGLE_NOT_SENT_MESSAGE);
            setLoading(false);
          }
        }}
      >
        <GoogleMark />
        Continue with Google
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Google "G" mark (inline SVG — lucide ships no brand logos). */
function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.28a7.21 7.21 0 0 1 0-4.56V6.61H1.27a12.01 12.01 0 0 0 0 10.78l4.01-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.44-3.44A11.53 11.53 0 0 0 12 0 12 12 0 0 0 1.27 6.61l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77Z"
      />
    </svg>
  );
}
