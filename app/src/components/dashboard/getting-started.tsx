"use client";

import Link from "next/link";
import { CheckCircle2, Globe, Link2, PenSquare, Sparkles } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { deriveGettingStarted, type GettingStartedStep, type WorkspaceSetup } from "@/lib/gettingStarted";
import type { ConnectionStatus } from "@/lib/connectionsDto";
import type { PostJobDTO } from "@/lib/postsDto";
import { readyToConnectSentence } from "@/lib/platformGuides";
import { SETTINGS_CONNECTIONS_HREF } from "@/lib/platforms";
import type { Platform } from "@prisma/client";

const POST_DEFAULTS_HREF = "/settings#post-defaults";

/**
 * First-run "Get started" checklist, shown at the top of the dashboard while
 * a step this person can do is open: for an owner, connect, the footer, the
 * brand voice and a first post; for a member, only the post, once something
 * is connected. Purely derived from the dashboard's fetches and the page's
 * workspace read (no dismissed flag): once the steps are provably done — or
 * while a source is still loading/failed — it renders nothing. See
 * lib/gettingStarted.ts.
 */
export function GettingStarted({
  connections,
  jobs,
  setup,
  availablePlatforms,
}: {
  connections: ConnectionStatus[] | null;
  jobs: PostJobDTO[] | null;
  setup: WorkspaceSetup | null;
  /** The platforms this site offers, so the first step names only those. */
  availablePlatforms: readonly Platform[];
}) {
  const state = deriveGettingStarted(connections, jobs, setup);
  if (!state.show) return null;
  const readySentence = readyToConnectSentence(availablePlatforms);
  const number = (step: GettingStartedStep) => state.steps.indexOf(step) + 1;
  const sees = (step: GettingStartedStep) => state.steps.includes(step);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Get started</CardTitle>
        <CardDescription>
          {state.steps.length > 1
            ? "Four steps to your first post. Steps 2 and 3 are settings that change every post."
            : "This workspace has a platform connected, so you can create posts."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {sees("connect") ? (
          <Step
            index={number("connect")}
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
          ) : null}
          {sees("footer") ? (
            <Step
              index={number("footer")}
              done={state.footerDone}
              title="Set what every post ends with"
              description="Your website and hashtags are added to the end of every post."
              action={
                <Link
                  href={POST_DEFAULTS_HREF}
                  className={buttonVariants({ variant: "outline", size: "sm", className: "gap-1.5" })}
                >
                  <Globe aria-hidden className="h-3.5 w-3.5" />
                  Add website
                </Link>
              }
            />
          ) : null}
          {sees("voice") ? (
            <Step
              index={number("voice")}
              done={state.voiceDone}
              title="Tell the AI how you sound"
              description="Captions the AI writes follow your notes and examples."
              action={
                <Link
                  href={POST_DEFAULTS_HREF}
                  className={buttonVariants({ variant: "outline", size: "sm", className: "gap-1.5" })}
                >
                  <Sparkles aria-hidden className="h-3.5 w-3.5" />
                  Add brand voice
                </Link>
              }
            />
          ) : null}
          <Step
            index={number("post")}
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

/**
 * "Working for clients?": the three client links, for owners, below the
 * dashboard's main content. Not a checklist: it stays once shown, appearing
 * after the Get started steps are done or as soon as the owner has a client
 * link on. Never shown to members, who cannot make these links.
 */
export function WorkingForClients({
  connections,
  jobs,
  setup,
}: {
  connections: ConnectionStatus[] | null;
  jobs: PostJobDTO[] | null;
  setup: WorkspaceSetup | null;
}) {
  if (!deriveGettingStarted(connections, jobs, setup).showClients) return null;
  const linkClass = "font-medium text-primary underline-offset-4 hover:underline";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Working for clients?</CardTitle>
        <CardDescription>
          Make each link on the page it opens, then send it yourself. Your client needs no account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li>
            <Link href={SETTINGS_CONNECTIONS_HREF} className={linkClass}>Send a connect link</Link>: your client
            connects their own accounts, without sharing a password.
          </li>
          <li>
            <Link href="/media" className={linkClass}>Send an upload link</Link>: your client sends photos and
            videos from their phone.
          </li>
          <li>
            <Link href="/queue" className={linkClass}>Send a review link</Link>: your client approves scheduled
            posts or asks for a change.
          </li>
        </ul>
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
