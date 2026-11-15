"use client";

import { SessionProvider } from "next-auth/react";
import { useEffect, type ReactNode } from "react";

import { readServerSession, useSignedInAccount, type ServerSession } from "@/components/signed-in-swap";
import { currentSignInGeneration, endStaleSession } from "@/lib/staleSignOut";

/**
 * SessionProvider that refetches `/api/auth/session` on window focus only.
 *
 * 2026-11-01 scale audit (W4): this used to poll every 60 s (`refetchInterval=
 * {60}`) in every tab, hidden ones included, and NextAuth broadcasts each
 * refetch to the other tabs, so requests grew with the square of the number of
 * open tabs. The timer is off (`0`); focus refetch stays so a returning user's
 * chrome catches up. Revocation (a password-reset `sessionVersion` bump) does
 * not depend on this client poll: server routes enforce `sessionVersion` on
 * every request via `getCurrentUser`, so a revoked session is rejected there
 * regardless of what the client chrome last saw.
 */
export function AppSessionProvider({ children }: { children: ReactNode }) {
  useEffect(() => watchSignedOutAnswers(window), []);
  return (
    <SessionProvider refetchInterval={0} refetchOnWindowFocus>
      <SessionPresence />
      {children}
    </SessionProvider>
  );
}

/**
 * GG1 review: whether this tab's session names someone, kept where the fetch
 * wrapper (outside the provider) can ask. Once it names nobody, a marked 401
 * has nothing left to end, so polling pages send no more reads or sign-outs.
 */
let tabNamesSomeone = false;

/** Keeps {@link tabNamesSomeone} in step with the session context; draws nothing. */
export function SessionPresence(): null {
  const named = useSignedInAccount() !== null;
  useEffect(() => {
    tabNamesSomeone = named;
  }, [named]);
  return null;
}

/** The mark signedOutResponse() puts on its 401 (lib/signedOutResponse.ts, which pins the same name). */
export const SIGNED_OUT_HEADER = "x-signed-out";

/** The fetch this module wrapped, so a second install is a no-op. */
const WRAPPED = Symbol.for("vibesocials.signedOutListener");

type Deps = {
  read?: (fetchImpl: typeof fetch) => Promise<ServerSession>;
  end?: (generation: number) => void;
  generation?: () => number;
  namesSomeone?: () => boolean;
};

/**
 * R21 pages L3: a 401 in the focused tab left the menu saying "Signed in as"
 * and gave no link, because the session was re-read only on the next focus.
 * This wraps the tab's fetch once: an answer from this site's /api/ carrying
 * the signed-out mark makes it ask the server for its session (through the
 * unwrapped fetch), and only a "signed out" answer ends the cached session
 * (endStaleSession), so the context names nobody and the shell shows its line.
 * "unknown" (offline, an error) and "signed in" change nothing; reads overlap
 * into one. Returns the cleanup that puts the browser's fetch back.
 */
export function watchSignedOutAnswers(win: Window, deps: Deps = {}): () => void {
  const current = win.fetch as typeof fetch & { [WRAPPED]?: true };
  if (current[WRAPPED]) return () => {};
  const {
    read = readServerSession,
    end = endStaleSession,
    generation = currentSignInGeneration,
    namesSomeone = () => tabNamesSomeone,
  } = deps;
  const original = current;
  const plainFetch: typeof fetch = (input, init) => original.call(win, input, init);
  let checking = false;

  function check() {
    if (checking || !namesSomeone()) return;
    checking = true;
    const asked = generation();
    void read(plainFetch)
      .then((session) => {
        if (session.kind === "signedOut") end(asked);
      })
      .catch(() => undefined)
      .finally(() => {
        checking = false;
      });
  }

  const wrapped = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await original.call(win, input, init);
      if (response.headers?.get(SIGNED_OUT_HEADER) === "1" && isOwnApi(input, win.location.origin)) check();
      return response;
    },
    { [WRAPPED]: true as const },
  );
  win.fetch = wrapped;
  return () => {
    if (win.fetch === wrapped) win.fetch = original;
  };
}

function isOwnApi(input: RequestInfo | URL, origin: string): boolean {
  try {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(address, origin);
    return url.origin === origin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}
