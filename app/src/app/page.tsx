"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { PenSquare, Settings, Star } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Landing } from "@/components/landing";
import { RecentActivity } from "@/components/dashboard/recent-activity";
import { ConnectionHealth } from "@/components/dashboard/connection-health";
import { GettingStarted } from "@/components/dashboard/getting-started";
import { YouTubeMetricsSummary } from "@/components/dashboard/youtube-metrics-summary";
import { useConnections } from "@/hooks/useConnections";
import { usePostJobs } from "@/hooks/usePostJobs";

export default function HomePage() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner size="lg" label="Loading" className="text-muted-foreground" />
      </div>
    );
  }

  if (status !== "authenticated") {
    return <Landing />;
  }

  return <Dashboard email={session?.user?.email ?? ""} />;
}

function Dashboard({ email }: { email: string }) {
  // Task 8 — single fetch/poll owner for the dashboard: both widgets below
  // took this over their own `usePostJobs()` call, so the dashboard makes one
  // `/api/posts` request (and one poll timer) instead of two. Same pattern
  // for connections: this is the one `/api/connections` fetch, shared by the
  // Get started checklist and the ConnectionHealth widget.
  const postJobs = usePostJobs();
  const connectionsState = useConnections();

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-6 lg:px-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Welcome back
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {email ? `Signed in as ${email}` : "Here's a look at your posts."}
          </p>
        </div>
        <Link
          href="/posts/new"
          className={buttonVariants({ variant: "primary", className: "gap-2" })}
        >
          <PenSquare aria-hidden className="h-4 w-4" />
          Create post
        </Link>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* First-run checklist — renders nothing once the user has a
              connection and a post (see lib/gettingStarted.ts). */}
          <GettingStarted
            connections={connectionsState.connections}
            jobs={postJobs.jobs}
          />
          {/* Roadmap Phase 8 — renders only once a YouTube post has fetched metrics. */}
          <YouTubeMetricsSummary jobs={postJobs.jobs} />
          <RecentActivity {...postJobs} />
        </div>
        <div className="space-y-6">
          <ConnectionHealth {...connectionsState} />
          <QuickActions />
        </div>
      </div>
    </div>
  );
}

function QuickActions() {
  const actions = [
    { href: "/posts/new", label: "Create post", icon: PenSquare },
    { href: "/settings", label: "Manage connections", icon: Settings },
    { href: "/reviews", label: "View reviews", icon: Star },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Quick actions</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {actions.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={buttonVariants({
              variant: "outline",
              className: "justify-start gap-2",
            })}
          >
            <Icon aria-hidden className="h-4 w-4 text-muted-foreground" />
            {label}
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
