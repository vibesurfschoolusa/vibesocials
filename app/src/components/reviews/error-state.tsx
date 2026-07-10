import { RefreshCw } from "lucide-react";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";

interface ErrorStateProps {
  title: string;
  message: string;
  onRetry: () => void;
}

/**
 * Inline, recoverable error card with a Retry action. Used for failed data
 * loads so a fetch failure does not blank the whole page. If the error looks
 * like a missing connection, it also surfaces a link to /settings (where
 * connection management now lives).
 */
export function ErrorState({ title, message, onRetry }: ErrorStateProps) {
  const showConnectionsLink = message.includes("not configured");

  return (
    <Alert variant="danger" title={title}>
      <div className="flex flex-col items-start gap-3">
        <p>{message}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" variant="destructive" onClick={onRetry}>
            <RefreshCw aria-hidden className="h-4 w-4" />
            Retry
          </Button>
          {showConnectionsLink && (
            <Link
              href="/settings"
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
