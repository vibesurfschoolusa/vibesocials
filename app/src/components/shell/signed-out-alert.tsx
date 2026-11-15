"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Alert } from "@/components/ui/alert";

/**
 * R20 new-customer L1 (= pages L1): an open app page whose session now names
 * nobody (password changed on another device, signed out in another tab). The
 * page stays as it is, so unsent work can still be copied; this line says what
 * happened and links back here after signing in.
 *
 * Only rendered once the client session has been read, never in the server's
 * HTML, so reading window.location for the query is safe. The pathname from
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
