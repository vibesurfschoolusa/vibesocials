"use client";

import { useContext, useEffect, useState, type ReactNode } from "react";
import { SessionContext, signOut } from "next-auth/react";

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

/** What the server's session answer says: someone, nobody, or it could not be read. */
export type ServerSession =
  | { kind: "signedIn"; account: SignedInAccount }
  | { kind: "signedOut" }
  | { kind: "unknown" };

/**
 * R18 new-customer L1, R19: the server's own session, read now. Not next-auth's
 * getSession(): in 4.24.15 it returns null for no session and for a failed
 * fetch alike, and a failed read must never sign anyone out. Here only a 200
 * with a JSON object counts; naming nobody ({} without a cookie, or
 * {"expires":"1970-..."} for a session the server ended) is "signedOut", and
 * offline, any other status or a body that is not a JSON object is "unknown".
 * It does not touch this tab's context or the other tabs.
 */
export async function readServerSession(fetchImpl: typeof fetch = fetch): Promise<ServerSession> {
  try {
    const response = await fetchImpl("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    if (response.status !== 200) return { kind: "unknown" };
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return { kind: "unknown" };
    const account = accountOf((body as { user?: { name?: string | null; email?: string | null } }).user);
    return account ? { kind: "signedIn", account } : { kind: "signedOut" };
  } catch {
    return { kind: "unknown" };
  }
}

export type ServerAnswer = { key: string; session: ServerSession };

/** Asks the server about the cached account; nothing to ask when it is signed out. Returns the effect's cleanup. */
export function startServerCheck(
  key: string | null,
  read: () => Promise<ServerSession>,
  onAnswer: (answer: ServerAnswer) => void,
): (() => void) | undefined {
  if (key === null) return undefined;
  let live = true;
  void read().then((session) => {
    if (live) onAnswer({ key, session });
  });
  return () => {
    live = false;
  };
}

/** The account to show as signed in: only the server's "signed in" about the account the cache names now. */
export function shownAccount(key: string | null, answer: ServerAnswer | null): SignedInAccount | null {
  if (key === null || answer?.key !== key || answer.session.kind !== "signedIn") return null;
  return answer.session.account;
}

/**
 * Log in and Register (R18 new-customer L1): a password reset, here or on
 * another device, ends the session on the server (sessionVersion, auth.ts),
 * but the cached client session is re-read only on page load and tab focus.
 * So the page says "already signed in" only once a fresh read of the server's
 * session says so; until it answers, or when it answers nobody or could not be
 * read, the form shows. R19: "signed out" also signs the cached session out,
 * so the header, the app frame and the other tabs stop naming the person; a
 * read that failed changes nothing.
 */
export function useFreshSignedInAccount(): SignedInAccount | null {
  const key = accountKey(useSignedInAccount());
  const [answer, setAnswer] = useState<ServerAnswer | null>(null);
  useEffect(() => {
    const generation = currentSignInGeneration();
    return startServerCheck(key, () => readServerSession(), showAndEndStale(setAnswer, () => endStaleSession(generation)));
  }, [key]);
  return shownAccount(key, answer);
}

/**
 * R19 new-customer L1: ends a cached session the server no longer has. In
 * next-auth 4.24.15 signOut({ redirect: false }) posts to /api/auth/signout,
 * which clears the session cookie, tells the other tabs, and re-reads this
 * tab's session, so its context becomes signed out. A failed sign-out (offline)
 * leaves the page as it is; the next session read tries again.
 */
export function endStaleSession(generation: number = signInGeneration): void {
  // EE1 review: never undo a sign-in made on this page. None is sent while a
  // sign-in runs, and none for a read that started before the latest sign-in
  // (that read described the session the sign-in replaced).
  if (signInsRunning > 0 || generation !== signInGeneration) return;
  staleSignOut = signOut({ redirect: false }).then(
    () => undefined,
    () => undefined,
  );
}

/** A stale sign-out already sent, which a sign-in waits for (its POST would clear the new cookie). */
let staleSignOut: Promise<void> = Promise.resolve();
/** Sign-ins started on this page; each one makes earlier reads' answers stale. */
let signInGeneration = 0;
let signInsRunning = 0;

/** The sign-in generation a session read starts in; its answer may end a stale session only in the same one. */
export function currentSignInGeneration(): number {
  return signInGeneration;
}

/**
 * Wraps a sign-in on Log in or Register: waits for a stale sign-out already
 * sent, and blocks new ones while it runs and for reads started before it.
 */
export async function beforeSignIn<T>(run: () => Promise<T>): Promise<T> {
  signInGeneration += 1;
  signInsRunning += 1;
  try {
    await staleSignOut;
    return await run();
  } finally {
    signInsRunning -= 1;
  }
}

/** Log in and Register: shows the server's answer and, only when it is "signed out", ends the cached session. */
export function showAndEndStale(show: (answer: ServerAnswer) => void, end: () => void): (answer: ServerAnswer) => void {
  return (answer) => {
    show(answer);
    if (answer.session.kind === "signedOut") end();
  };
}

/**
 * Where the server rendered the signed-out page but the cached session names
 * someone: a fresh read naming nobody signs out; one naming the person means
 * the server's page saw a blip (the jwt callback keeps the token on a database
 * error, auth.ts), so the page is refreshed, once per account (`refreshed`); a
 * read that failed changes nothing.
 */
export function startSignedOutSync(
  key: string | null,
  read: () => Promise<ServerSession>,
  actions: { signOut: () => void; refresh: () => void },
  refreshed: Set<string>,
): (() => void) | undefined {
  return startServerCheck(key, read, ({ key: asked, session }) => {
    if (session.kind === "signedOut") {
      actions.signOut();
    } else if (session.kind === "signedIn" && !refreshed.has(asked)) {
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
    () => startSignedOutSync(key, () => readServerSession(), { signOut: endStaleSession, refresh }, refreshed),
    [key, refresh, refreshed],
  );
}

/** `signedOut` until the session says someone is signed in, then `signedIn`. */
export function SignedInSwap({ signedIn, signedOut }: { signedIn: ReactNode; signedOut: ReactNode }) {
  return <>{useSignedInAccount() ? signedIn : signedOut}</>;
}
