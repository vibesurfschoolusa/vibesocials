"use client";

import { useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SessionContext } from "next-auth/react";

import { readServerSession, type ServerSession } from "@/components/signed-in-swap";
import { Alert } from "@/components/ui/alert";

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

/**
 * R20 new-customer L1 (= pages L1): an open app page whose session now names
 * nobody (password changed on another device, signed out in another tab). The
 * page stays as it is, so unsent work can still be copied; this line says what
 * happened and links back here after signing in.
 *
 * Only rendered once the server has said so (useServerSaysSignedOut), never
 * in the server's HTML, so reading window.location for the query is safe. The pathname from
 * usePathname makes it render again after a client-side navigation.
 */
export function SignedOutAlert() {
  const pathname = usePathname();
  const here = typeof window === "undefined" ? pathname : `${window.location.pathname}${window.location.search}`;
  return (
    <div className="px-4 pt-4 md:px-6">
      <Alert variant="warning" className="items-center p-3">
        <span className="text-foreground">
          You were signed out.{" "}
          <Link
            href={`/login?callbackUrl=${encodeURIComponent(here)}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Sign in again
          </Link>{" "}
          to keep working.
        </span>
      </Alert>
    </div>
  );
}
