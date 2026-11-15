"use client";

import { useContext, useEffect, useState, type ReactNode } from "react";
import { getSession, SessionContext } from "next-auth/react";
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
  const user = session.data?.user;
  return { name: user?.name ?? null, email: user?.email ?? null };
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
    const user = (await read())?.user;
    return user ? { name: user.name ?? null, email: user.email ?? null } : null;
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
 */
export function useFreshSignedInAccount(): SignedInAccount | null {
  const key = accountKey(useSignedInAccount());
  const [answer, setAnswer] = useState<ServerAnswer | null>(null);
  useEffect(() => startServerCheck(key, readServerAccount, setAnswer), [key]);
  return shownAccount(key, answer);
}

/** `signedOut` until the session says someone is signed in, then `signedIn`. */
export function SignedInSwap({ signedIn, signedOut }: { signedIn: ReactNode; signedOut: ReactNode }) {
  return <>{useSignedInAccount() ? signedIn : signedOut}</>;
}
