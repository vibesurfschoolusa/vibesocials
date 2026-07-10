"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { PLATFORM_ORDER, platformLabel } from "@/lib/platforms";
import { useConnections } from "@/hooks/useConnections";

/** Dashboard widget: at-a-glance connected/disconnected status per platform. */
export function ConnectionHealth() {
  const { connections, loading, error } = useConnections();
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
        {loading ? (
          <div className="space-y-2" aria-hidden>
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-7 w-full" />
            ))}
          </div>
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
                {connection.connected && !connection.needsReconnect ? (
                  <Badge variant="success">
                    <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />
                    Connected
                  </Badge>
                ) : connection.connected ? (
                  // Roadmap Phase 4: danger badge, links straight to this
                  // platform's OAuth start (a plain anchor — /api/auth/* is a
                  // redirect handler, not a Next.js route).
                  <a href={`/api/auth/${connection.platform}/start`}>
                    <Badge variant="danger" className="cursor-pointer hover:opacity-80">
                      <AlertTriangle aria-hidden className="h-3.5 w-3.5" />
                      Reconnect
                    </Badge>
                  </a>
                ) : (
                  <Link
                    href="/settings"
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

        <Link
          href="/settings"
          className={buttonVariants({
            variant: "outline",
            size: "sm",
            className: "w-full",
          })}
        >
          Manage connections
        </Link>
      </CardContent>
    </Card>
  );
}
