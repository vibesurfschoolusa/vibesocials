import { getSession, signOut } from "next-auth/react";

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
 *
 * R21 pages L2: in next-auth 4.24.15 a credentials signIn({ redirect: false })
 * re-reads only this tab's session, without telling the other tabs
 * (react/index.js:273-275, :399-402), so an open page there kept its
 * signed-out line. After an accepted sign-in, one getSession() (it broadcasts
 * by default, :129-136) makes them read it again. A failed broadcast read
 * never undoes the sign-in.
 */
export async function beforeSignIn<T>(run: () => Promise<T>): Promise<T> {
  signInGeneration += 1;
  signInsRunning += 1;
  try {
    await staleSignOut;
    const result = await run();
    if ((result as { ok?: unknown } | null | undefined)?.ok === true) {
      await getSession().catch(() => null);
    }
    return result;
  } finally {
    signInsRunning -= 1;
  }
}

/**
 * R21 pages L2: re-reads this tab's session and sets its context. In next-auth
 * 4.24.15 a tab whose session is null is not re-read on focus
 * (react/index.js:408-412), and update() does nothing without a session
 * (:492-496). The one path that re-reads and sets it is the receiver for the
 * other tabs' messages (:443-448 -> _getSession({ event: "storage" })), which
 * listens for the window's "storage" event (client/_utils.js:88-103); this
 * hands it one. Nothing is written to storage, so no other tab hears it.
 */
export function rereadSessionHere(win: Window = window): void {
  if (typeof StorageEvent === "undefined") return;
  win.dispatchEvent(
    new StorageEvent("storage", {
      key: "nextauth.message",
      newValue: JSON.stringify({ event: "session", data: { trigger: "getSession" } }),
    }),
  );
}
