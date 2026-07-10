import { AlertCircle, RefreshCw } from "lucide-react";
import Link from "next/link";

interface ErrorStateProps {
  title: string;
  message: string;
  onRetry: () => void;
}

/**
 * Inline, recoverable error card with a Retry action. Used for failed data
 * loads so a fetch failure does not blank the whole page. If the error looks
 * like a missing connection, it also surfaces a link to /connections.
 */
export function ErrorState({ title, message, onRetry }: ErrorStateProps) {
  const showConnectionsLink = message.includes("not configured");

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-6">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="font-semibold text-red-900">{title}</h3>
          <p className="mt-1 text-sm text-red-700">{message}</p>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Retry
            </button>
            {showConnectionsLink && (
              <Link
                href="/connections"
                className="text-sm text-blue-600 hover:text-blue-700 underline"
              >
                Go to Connections →
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
