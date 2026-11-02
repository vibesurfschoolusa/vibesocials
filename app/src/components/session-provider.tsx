"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";

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
  return (
    <SessionProvider refetchInterval={0} refetchOnWindowFocus>
      {children}
    </SessionProvider>
  );
}
