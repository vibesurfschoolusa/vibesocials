"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { PLATFORM_ORDER, platformLabel, SETTINGS_CONNECTIONS_HREF } from "@/lib/platforms";
import type { ConnectionStatus } from "@/lib/connectionsDto";
import type { UseConnectionsResult } from "@/hooks/useConnections";

/**
 * R11-client-journey L2: what a member reads for a row that isn't healthy.
 * Only the owner can connect or reconnect (a member's Settings is read-only),
 * so a member gets the state, not a button into Settings.
 */
function MemberState({ connection }: { connection: ConnectionStatus }) {
  if (!connection.connected) return <Badge variant="neutral">Not connected</Badge>;
  if (connection.needsReconnect) return <Badge variant="danger">Needs reconnecting</Badge>;
  return (
    <Badge variant={connection.expiry === "ended" ? "danger" : "warning"}>
      {connection.expiry === "ended" ? "Ended" : "Ends soon"}
    </Badge>
  );
}

function isHealthy(connection: ConnectionStatus): boolean {
  return connection.connected && !connection.needsReconnect && !connection.expiry;
}

/**
 * Dashboard widget: at-a-glance connected/disconnected status per platform.
 * Takes the dashboard's single `useConnections()` result as props (same
 * single-fetch-owner pattern as RecentActivity/usePostJobs) so the Get
 * started checklist and this widget share one `/api/connections` request.
 */
export function ConnectionHealth({
  connections,
  loading,
  error,
  isMember = false,
}: Pick<UseConnectionsResult, "connections" | "loading" | "error"> & { isMember?: boolean }) {
  const ordered = connections
    ? [...connections].sort(
        (a, b) =>
          PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform),
      )
    : [];
  const connectedCount = connections
    ? connections.filter((connection) => connection.connected).length
    : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connections</CardTitle>
        <CardDescription>
          {connections
            ? `${connectedCount} of ${connections.length} platforms connected`
            : "Platform connection status"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* R30 PP2: status lines stay on the page from the first render; only their text changes. */}
        <p role="status" className="sr-only">{loading ? "Loading connection health…" : ""}</p>
        {loading ? (
          <>
            <div className="space-y-2" aria-hidden>
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-7 w-full" />
              ))}
            </div>
          </>
        ) : error ? (
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load connection status.
          </p>
        ) : (
          <ul className="space-y-1">
            {ordered.map((connection) => (
              <li
                key={connection.platform}
                className="flex items-center justify-between gap-2 py-0.5"
              >
                <span className="flex items-center gap-2 text-sm text-foreground">
                  <span
                    aria-hidden
                    className={cn(
                      "h-2 w-2 rounded-full",
                      connection.connected
                        ? "bg-success"
                        : "bg-muted-foreground/40",
                    )}
                  />
                  {platformLabel(connection.platform)}
                </span>
                {isMember && !isHealthy(connection) ? (
                  <MemberState connection={connection} />
                ) : connection.connected && !connection.needsReconnect && connection.expiry ? (
                  // R7-pages L4: it still works (or just stopped) but can't be
                  // renewed: Settings has its Reconnect.
                  <Link
                    href={SETTINGS_CONNECTIONS_HREF}
                    className={buttonVariants({
                      variant: connection.expiry === "ended" ? "destructive" : "outline",
                      size: "sm",
                      className: "h-7 gap-1 px-2 text-xs",
                    })}
                  >
                    <AlertTriangle aria-hidden className="h-3.5 w-3.5" />
                    {connection.expiry === "ended" ? "Ended" : "Ends soon"}
                  </Link>
                ) : connection.connected && !connection.needsReconnect ? (
                  // One check, not a "Connected" badge beside the green dot: at
                  // the shared page width the badge made long names wrap.
                  <span title="Connected" className="inline-flex shrink-0 items-center text-success">
                    <CheckCircle2 aria-hidden className="h-4 w-4" />
                    <span className="sr-only">Connected</span>
                  </span>
                ) : connection.connected ? (
                  // Roadmap Phase 4: destructive button. F3: it goes to
                  // Settings, not straight to the OAuth start. The start
                  // needs the workspace a page was rendered for, and this
                  // widget's list is fetched, not rendered for one; Settings'
                  // own Reconnect carries it.
                  <Link
                    href={SETTINGS_CONNECTIONS_HREF}
                    className={buttonVariants({
                      variant: "destructive",
                      size: "sm",
                      className: "h-7 gap-1 px-2 text-xs",
                    })}
                  >
                    <AlertTriangle aria-hidden className="h-3.5 w-3.5" />
                    Reconnect
                  </Link>
                ) : (
                  <Link
                    href={SETTINGS_CONNECTIONS_HREF}
                    className={buttonVariants({
                      variant: "ghost",
                      size: "sm",
                      className: "h-7 px-2 text-xs",
                    })}
                  >
                    Connect
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}

        {isMember ? (
          !loading && !error && ordered.some((connection) => !isHealthy(connection)) ? (
            <p className="text-sm text-muted-foreground">
              The workspace owner can connect and reconnect accounts for this workspace.
            </p>
          ) : null
        ) : (
          <Link
            href={SETTINGS_CONNECTIONS_HREF}
            className={buttonVariants({
              variant: "outline",
              size: "sm",
              className: "w-full",
            })}
          >
            Manage connections
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
