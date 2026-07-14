"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";

/**
 * SessionProvider with a short refetch so password-reset sessionVersion bumps
 * (auth jwt callback returns null) clear client chrome within ~1 minute rather
 * than waiting for the 30-day JWT maxAge.
 */
export function AppSessionProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider refetchInterval={60} refetchOnWindowFocus>
      {children}
    </SessionProvider>
  );
}
