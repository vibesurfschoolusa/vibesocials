"use client";

import Link from "next/link";
import { CheckCircle2, Link2, PenSquare } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { deriveGettingStarted } from "@/lib/gettingStarted";
import type { ConnectionStatus } from "@/lib/connectionsDto";
import type { PostJobDTO } from "@/lib/postsDto";
import { readyToConnectSentence } from "@/lib/platformGuides";
import { SETTINGS_CONNECTIONS_HREF } from "@/lib/platforms";
import type { Platform } from "@prisma/client";

/**
 * First-run "Get started" checklist, shown at the top of the dashboard until
 * the user has connected a platform AND created a post. Purely derived from
 * the dashboard's existing fetches (no dismissed flag): once both steps are
 * provably done — or while either source is still loading/failed — it
 * renders nothing. See lib/gettingStarted.ts.
 */
export function GettingStarted({
  connections,
  jobs,
  availablePlatforms,
}: {
  connections: ConnectionStatus[] | null;
  jobs: PostJobDTO[] | null;
  /** The platforms this site offers, so the first step names only those. */
  availablePlatforms: readonly Platform[];
}) {
  const state = deriveGettingStarted(connections, jobs);
  if (!state.show) return null;
  const readySentence = readyToConnectSentence(availablePlatforms);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Get started</CardTitle>
        <CardDescription>
          Two quick steps to your first cross-platform post.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          <Step
            index={1}
            done={state.connectDone}
            title="Connect a platform"
            description="Link YouTube, X, Instagram, or any of the others in Settings."
            note={
              readySentence ? (
                <>
                  {readySentence}{" "}
                  <Link href="/help" className="font-medium text-primary underline-offset-4 hover:underline">
                    setup guide
                  </Link>
                  .
                </>
              ) : (
                <>
                  Each platform needs something different.{" "}
                  <Link href="/help" className="font-medium text-primary underline-offset-4 hover:underline">
                    Read the setup guide.
                  </Link>
                </>
              )
            }
            action={
              <Link
                href={SETTINGS_CONNECTIONS_HREF}
                className={buttonVariants({
                  variant: "primary",
                  size: "sm",
                  className: "gap-1.5",
                })}
              >
                <Link2 aria-hidden className="h-3.5 w-3.5" />
                Connect
              </Link>
            }
          />
          <Step
            index={2}
            done={state.postDone}
            title="Create your first post"
            description="Upload once, pick your platforms, and publish or schedule."
            action={
              <Link
                href="/posts/new"
                className={buttonVariants({
                  variant: state.connectDone ? "primary" : "outline",
                  size: "sm",
                  className: "gap-1.5",
                })}
              >
                <PenSquare aria-hidden className="h-3.5 w-3.5" />
                Create post
              </Link>
            }
          />
        </ol>
      </CardContent>
    </Card>
  );
}

function Step({
  index,
  done,
  title,
  description,
  note,
  action,
}: {
  index: number;
  done: boolean;
  title: string;
  description: string;
  /** A second line under the description, while the step is not done. */
  note?: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      {done ? (
        <CheckCircle2
          aria-hidden
          className="mt-0.5 h-6 w-6 shrink-0 text-success"
        />
      ) : (
        <span
          aria-hidden
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs font-semibold text-muted-foreground"
        >
          {index}
        </span>
      )}
      <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p
            className={cn(
              "text-sm font-medium",
              done ? "text-muted-foreground line-through" : "text-foreground",
            )}
          >
            {title}
            {done ? <span className="sr-only"> (done)</span> : null}
          </p>
          {!done ? (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          ) : null}
          {!done && note ? (
            <p className="mt-0.5 text-sm text-muted-foreground">{note}</p>
          ) : null}
        </div>
        {!done ? <div className="shrink-0">{action}</div> : null}
      </div>
    </li>
  );
}
