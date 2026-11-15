"use client";

import { useContext, useEffect, useState, type ReactNode } from "react";
import { getSession, SessionContext, signOut } from "next-auth/react";
import type { Session } from "next-auth";

export type SignedInAccount = { name: string | null; email: string | null };

/**
 * The signed-in account from the client session, or null (R17-pages L1).
 * Null until the session is read, so the server's HTML is the signed-out page
 * byte for byte (publicPagesBillingOff.test.ts pins it). Reads next-auth's
 * context directly instead of useSession, which throws without a provider.
 */
export function useSignedInAccount(): SignedInAccount | null {
  const session = useContext(SessionContext);
  if (session?.status !== "authenticated") return null;
  return accountOf(session.data?.user);
}

/**
 * The account a session names, or null: the client's one rule for "signed in"
 * (the header, About, the app frame, the account menu). A session the server
 * ended answers {"expires":"1970-..."} with no user, which next-auth 4.24 still
 * calls "authenticated" (auth.ts: an invalid sessionVersion expires the
 * session); that is nobody. A tab whose cached session was read before the
 * server ended it still names the person until it is read again; the
 * signed-out pages read it again (ServerSignedOutSync, useFreshSignedInAccount).
 */
function accountOf(user: { name?: string | null; email?: string | null } | null | undefined): SignedInAccount | null {
  if (!user?.email && !user?.name) return null;
  return { name: user.name ?? null, email: user.email ?? null };
}

/** Which cached account a server answer was about. */
export function accountKey(account: SignedInAccount | null): string | null {
  return account ? `${account.email ?? ""}\n${account.name ?? ""}` : null;
}

/**
 * R18 new-customer L1: the server's own session, read now. In next-auth 4.24.15
 * getSession() fetches /api/auth/session and returns null for no session and
 * for a failed fetch alike, but it never updates this tab's context, and the
 * context's update() keeps the old session when the answer is empty; so the
 * answer is kept here. broadcast: false, so the other tabs do not refetch.
 */
export async function readServerAccount(
  read: () => Promise<Session | null> = () => getSession({ broadcast: false }),
): Promise<SignedInAccount | null> {
  try {
    return accountOf((await read())?.user);
  } catch {
    return null;
  }
}

export type ServerAnswer = { key: string; account: SignedInAccount | null };

/** Asks the server about the cached account; nothing to ask when it is signed out. Returns the effect's cleanup. */
export function startServerCheck(
  key: string | null,
  read: () => Promise<SignedInAccount | null>,
  onAnswer: (answer: ServerAnswer) => void,
): (() => void) | undefined {
  if (key === null) return undefined;
  let live = true;
  void read().then((account) => {
    if (live) onAnswer({ key, account });
  });
  return () => {
    live = false;
  };
}

/** The account to show as signed in: only the server's answer about the account the cache names now. */
export function shownAccount(key: string | null, answer: ServerAnswer | null): SignedInAccount | null {
  return key !== null && answer?.key === key ? answer.account : null;
}

/**
 * Log in and Register (R18 new-customer L1): a password reset, here or on
 * another device, ends the session on the server (sessionVersion, auth.ts),
 * but the cached client session is re-read only on page load and tab focus.
 * So the page says "already signed in" only once a fresh read of the server's
 * session says so; until it answers, or when it answers nobody, the form shows.
 * R19: an answer of nobody also signs the cached session out, so the header,
 * the app frame and the other tabs stop naming the person.
 */
export function useFreshSignedInAccount(): SignedInAccount | null {
  const key = accountKey(useSignedInAccount());
  const [answer, setAnswer] = useState<ServerAnswer | null>(null);
  useEffect(() => startServerCheck(key, readServerAccount, showAndEndStale(setAnswer, endStaleSession)), [key]);
  return shownAccount(key, answer);
}

/**
 * R19 new-customer L1: ends a cached session the server no longer has. In
 * next-auth 4.24.15 signOut({ redirect: false }) posts to /api/auth/signout,
 * which clears the session cookie, tells the other tabs, and re-reads this
 * tab's session, so its context becomes signed out. A failed sign-out (offline)
 * leaves the page as it is; the next session read tries again.
 */
export function endStaleSession(): void {
  signOut({ redirect: false }).catch(() => undefined);
}

/** Log in and Register: shows the server's answer and, when it names nobody, ends the cached session. */
export function showAndEndStale(show: (answer: ServerAnswer) => void, end: () => void): (answer: ServerAnswer) => void {
  return (answer) => {
    show(answer);
    if (!answer.account) end();
  };
}

/**
 * Where the server rendered the signed-out page but the cached session names
 * someone: a fresh read naming nobody signs out; one naming the person means
 * the server's page saw a blip (the jwt callback keeps the token on a database
 * error, auth.ts), so the page is refreshed, once per account (`refreshed`).
 */
export function startSignedOutSync(
  key: string | null,
  read: () => Promise<SignedInAccount | null>,
  actions: { signOut: () => void; refresh: () => void },
  refreshed: Set<string>,
): (() => void) | undefined {
  return startServerCheck(key, read, ({ key: asked, account }) => {
    if (!account) {
      actions.signOut();
    } else if (!refreshed.has(asked)) {
      refreshed.add(asked);
      actions.refresh();
    }
  });
}

/** The client side of a page the server rendered signed out; `refresh` renders it again on the server. */
export function useFollowSignedOutServer(refresh: () => void): void {
  const key = accountKey(useSignedInAccount());
  const [refreshed] = useState(() => new Set<string>());
  useEffect(
    () => startSignedOutSync(key, readServerAccount, { signOut: endStaleSession, refresh }, refreshed),
    [key, refresh, refreshed],
  );
}

/** `signedOut` until the session says someone is signed in, then `signedIn`. */
export function SignedInSwap({ signedIn, signedOut }: { signedIn: ReactNode; signedOut: ReactNode }) {
  return <>{useSignedInAccount() ? signedIn : signedOut}</>;
}
