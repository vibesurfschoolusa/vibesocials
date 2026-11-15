import { signOut } from "next-auth/react";

// A plain module (not "use client") so Log in's sign-in helper can use it:
// clientBoundary.guard.test.ts forbids calling a "use client" module's plain
// functions from code that isn't one.

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
