"use client";

import { useContext, useEffect, useState } from "react";
import { SessionContext } from "next-auth/react";

import { readServerSession, type ServerSession } from "@/components/signed-in-swap";
import { Alert } from "@/components/ui/alert";
import { rereadSessionHere } from "@/lib/staleSignOut";

/**
 * FF1 review: true only once the server itself says this tab is signed out.
 * next-auth 4.24.15 also reports "unauthenticated" after a failed session
 * fetch (offline, a 5xx), for someone still signed in, so `nobody` (what the
 * client session says) is only the cue to ask. The server is read once each
 * time the client session changes while it names nobody (a later focus or
 * another tab's broadcast gives a new session, so it is read again); an
 * answer for an earlier session is ignored. "signedIn" and "unknown" answers
 * leave the page as it is.
 */
export function useServerSaysSignedOut(
  nobody: boolean,
  read: () => Promise<ServerSession> = readServerSession,
): boolean {
  const session = useContext(SessionContext);
  const [answer, setAnswer] = useState<{ about: unknown; signedOut: boolean } | null>(null);
  useEffect(() => {
    if (!nobody) return;
    let live = true;
    void read().then((server) => {
      if (live) setAnswer({ about: session, signedOut: server.kind === "signedOut" });
    });
    return () => {
      live = false;
    };
  }, [nobody, session, read]);
  return nobody && answer !== null && answer.about === session && answer.signedOut;
}

const LINK_CLASS = "font-medium text-primary underline-offset-4 hover:underline";

/**
 * Where "Sign in again" goes. In a browser tab: Log in in a new tab, which
 * lands on /signed-in-again (#177), so this page and what it holds stay. In an
 * installed app (display-mode standalone, or iOS's navigator.standalone) a new
 * tab would open the browser, with other cookies: Log in in the same view,
 * coming back to this page.
 */
export function signInAgainLink(win: Window | undefined): { href: string; newTab: boolean } {
  const standalone =
    !!win &&
    ((typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches) ||
      (win.navigator as Navigator & { standalone?: boolean } | undefined)?.standalone === true);
  if (!standalone || !win) {
    return { href: `/login?callbackUrl=${encodeURIComponent("/signed-in-again")}`, newTab: true };
  }
  const here = `${win.location.pathname}${win.location.search}${win.location.hash}`;
  return { href: `/login?callbackUrl=${encodeURIComponent(here)}`, newTab: false };
}

/**
 * R20 new-customer L1 (= pages L1): an open app page whose session now names
 * nobody (password changed on another device, signed out in another tab). The
 * page stays as it is, so unsent work is kept; this line says what happened.
 *
 * R21 new-customer L1 (= pages L1): the link opens Log in in a new tab, so
 * this page (Create has no saved draft) is not left. R21 pages L2: while the
 * line shows, coming back to this tab re-reads its session (next-auth does not
 * re-read a null session on focus), so a sign-in in the other tab clears the
 * line and the account menu returns.
 *
 * GG1 follow-up: the new tab lands on /signed-in-again, not on this page,
 * which would open a second, empty copy of it.
 *
 * R22 new-customer / pages: an installed app (an iPhone home-screen web app
 * above all) keeps its own cookies, apart from the browser's, so a new tab
 * opens the browser and a sign-in there never reaches the app. There the link
 * opens Log in in the same view and comes back to this page
 * (signInAgainLink), and the line says to copy unsent work first.
 *
 * Only rendered once the server has said so (useServerSaysSignedOut), never
 * in the server's HTML.
 */
export function SignedOutAlert() {
  const [link] = useState(() => signInAgainLink(typeof window === "undefined" ? undefined : window));
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") rereadSessionHere(window);
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return (
    <div className="px-4 pt-4 md:px-6">
      <Alert variant="warning" className="items-center p-3">
        <span className="text-foreground">
          You were signed out.{" "}
          {link.newTab ? (
            <>
              <a href={link.href} target="_blank" rel="noopener" className={LINK_CLASS}>
                Sign in again in a new tab
              </a>
              , then come back: this page keeps what you wrote.
            </>
          ) : (
            <>
              <a href={link.href} className={LINK_CLASS}>
                Sign in again
              </a>
              . Copy anything you haven&apos;t sent first: this page will reload.
            </>
          )}
        </span>
      </Alert>
    </div>
  );
}
