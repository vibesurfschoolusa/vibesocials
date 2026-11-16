import { RefreshCw } from "lucide-react";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { SignInAgainLink } from "@/components/gbp-sign-in-link";
import { GBP_CARD_HREF } from "@/lib/gbpSignIn";
import { SETTINGS_CONNECTIONS_HREF } from "@/lib/platforms";

interface ErrorStateProps {
  title: string;
  message: string;
  onRetry: () => void;
  /** Google refused the request (F7): the way out is reconnecting in Settings. */
  settingsLink?: boolean;
  /**
   * R12 L1: a member's Settings is read-only, so a member never gets the link;
   * the routes word a member's message for them (who can reconnect).
   */
  isMember: boolean;
  /** JJ3 lead review: an owner's in-place Google sign-in (lib/gbpSignIn.ts). */
  signInUrl?: string;
}

/**
 * Inline, recoverable error card with a Retry action. Used for failed data
 * loads so a fetch failure does not blank the whole page. If the error looks
 * like a missing connection, it also surfaces a link to /settings (where
 * connection management now lives).
 */
export function ErrorState({ title, message, onRetry, settingsLink = false, isMember, signInUrl }: ErrorStateProps) {
  const showConnectionsLink = !isMember && (settingsLink || message.includes("not configured"));

  return (
    <Alert variant="danger" title={title}>
      <div className="flex flex-col items-start gap-3">
        <p>{message}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" variant="destructive" onClick={onRetry}>
            <RefreshCw aria-hidden className="h-4 w-4" />
            Retry
          </Button>
          {signInUrl && !isMember ? <SignInAgainLink href={signInUrl} /> : null}
          {showConnectionsLink && (
            <Link
              // JJ3 lead review: a Google failure goes straight to the Google
              // Business Profile card; the not-configured message to Connections.
              href={settingsLink ? GBP_CARD_HREF : SETTINGS_CONNECTIONS_HREF}
              className={buttonVariants({
                variant: "link",
                size: "sm",
                className: "px-0",
              })}
            >
              Go to Settings →
            </Link>
          )}
        </div>
      </div>
    </Alert>
  );
}
