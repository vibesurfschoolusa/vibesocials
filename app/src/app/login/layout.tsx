import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * F7 (R1 L6): the login page is a client component, which cannot export
 * metadata, so this server layout names the browser tab.
 */
export const metadata: Metadata = {
  title: "Log in | Vibe Socials",
};

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
