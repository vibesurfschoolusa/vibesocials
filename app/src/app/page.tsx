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
import { RecentActivity } from "@/components/dashboard/recent-activity";
import { ConnectionHealth } from "@/components/dashboard/connection-health";
import { YouTubeMetricsSummary } from "@/components/dashboard/youtube-metrics-summary";

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

/** Signed-out hero. The one place a subtle brand gradient is allowed. */
function Landing() {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-primary/5 via-background to-background"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
      />
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center text-center">
          <span
            aria-hidden
            className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-lg font-bold text-white shadow-lg"
          >
            VS
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            Vibe Socials
          </h1>
          <p className="mt-3 text-base text-muted-foreground">
            Upload once, post everywhere. Manage and sync your content across
            TikTok, YouTube, Instagram, and more — from a single place.
          </p>
        </div>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/login"
            className={buttonVariants({
              variant: "primary",
              size: "lg",
              className: "flex-1",
            })}
          >
            Log in
          </Link>
          <Link
            href="/register"
            className={buttonVariants({
              variant: "outline",
              size: "lg",
              className: "flex-1",
            })}
          >
            Create account
          </Link>
        </div>
      </div>
    </div>
  );
}

function Dashboard({ email }: { email: string }) {
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
          {/* Roadmap Phase 8 — renders only once a YouTube post has fetched metrics. */}
          <YouTubeMetricsSummary />
          <RecentActivity />
        </div>
        <div className="space-y-6">
          <ConnectionHealth />
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
