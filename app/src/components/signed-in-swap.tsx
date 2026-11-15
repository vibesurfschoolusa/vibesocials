"use client";

import { useContext, type ReactNode } from "react";
import { SessionContext } from "next-auth/react";

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

/** `signedOut` until the session says someone is signed in, then `signedIn`. */
export function SignedInSwap({ signedIn, signedOut }: { signedIn: ReactNode; signedOut: ReactNode }) {
  return <>{useSignedInAccount() ? signedIn : signedOut}</>;
}
