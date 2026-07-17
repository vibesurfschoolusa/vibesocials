"use client";

import Link from "next/link";
import {
  Activity,
  CalendarClock,
  Link2,
  PenSquare,
  Send,
  Sparkles,
  Star,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { PLATFORM_ORDER, platformLabel } from "@/lib/platforms";

/**
 * Signed-out marketing page for `/`. Purely presentational — no data
 * fetches, no session reads (HomePage only renders it when the session is
 * known to be unauthenticated). One <h1> per the smoke-suite a11y rule;
 * section headings are <h2>. The subtle brand gradient stays landing-only.
 */
export function Landing() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-primary/5 via-background to-background"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
      />

      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-5 md:px-6">
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-700 text-xs font-bold text-white"
          >
            VS
          </span>
          <span className="text-sm font-semibold text-foreground">
            Vibe Socials
          </span>
        </span>
        <Link
          href="/login"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Log in
        </Link>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 md:px-6">
        {/* Hero */}
        <section className="flex flex-col items-center pb-14 pt-10 text-center sm:pt-16">
          <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            Upload once. Post everywhere.
          </h1>
          <p className="mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">
            One composer for your video, photo, and text posts — published or
            scheduled across every platform you&apos;re on, with your whole
            team in one workspace.
          </p>
          <div className="mt-8 flex w-full max-w-md flex-col gap-3 sm:flex-row">
            <Link
              href="/register"
              className={buttonVariants({
                variant: "primary",
                size: "lg",
                className: "flex-1",
              })}
            >
              Create free account
            </Link>
            <Link
              href="/login"
              className={buttonVariants({
                variant: "outline",
                size: "lg",
                className: "flex-1",
              })}
            >
              Log in
            </Link>
          </div>

          <ul className="mt-10 flex max-w-2xl flex-wrap items-center justify-center gap-2">
            {PLATFORM_ORDER.map((platform) => (
              <li
                key={platform}
                className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground"
              >
                {platformLabel(platform)}
              </li>
            ))}
          </ul>
        </section>

        {/* Features */}
        <section aria-labelledby="features-heading" className="pb-14">
          <h2
            id="features-heading"
            className="text-center text-2xl font-bold tracking-tight text-foreground"
          >
            Everything your posts need, in one place
          </h2>
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Feature
              icon={Send}
              title="One composer, every platform"
              description="Write a caption, attach your media, pick platforms — we handle each network's formats and limits."
            />
            <Feature
              icon={CalendarClock}
              title="Schedule and drafts"
              description="Publish now, schedule for later, or park it as a draft. Cancel or retry any time from the queue."
            />
            <Feature
              icon={Sparkles}
              title="AI captions"
              description="Auto-draft a caption from your media, or enhance the one you wrote — then edit before anything ships."
            />
            <Feature
              icon={Users}
              title="Team workspaces"
              description="Invite teammates into a shared workspace with connected accounts, activity, and media in common."
            />
            <Feature
              icon={Activity}
              title="Activity and connection health"
              description="See exactly where each post landed, and get flagged the moment a platform connection needs attention."
            />
            <Feature
              icon={Star}
              title="Google reviews inbox"
              description="Read and answer your Google Business reviews — with an AI-drafted reply one click away."
            />
          </div>
        </section>

        {/* How it works */}
        <section aria-labelledby="how-heading" className="pb-14">
          <h2
            id="how-heading"
            className="text-center text-2xl font-bold tracking-tight text-foreground"
          >
            Up and running in minutes
          </h2>
          <ol className="mx-auto mt-8 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-3">
            <HowStep
              index={1}
              icon={Link2}
              title="Connect your accounts"
              description="Link the platforms you post to with a secure sign-in for each."
            />
            <HowStep
              index={2}
              icon={PenSquare}
              title="Compose once"
              description="Add media and a caption; tailor per-platform details if you want."
            />
            <HowStep
              index={3}
              icon={Send}
              title="Publish or schedule"
              description="Ship it everywhere at once and watch the results roll into your activity feed."
            />
          </ol>
        </section>

        {/* Final CTA */}
        <section className="pb-16">
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card px-6 py-10 text-center">
            <h2 className="text-2xl font-bold tracking-tight text-foreground">
              Ready to post everywhere?
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Create a free account — no credit card, your first workspace is
              set up automatically.
            </p>
            <Link
              href="/register"
              className={buttonVariants({ variant: "primary", size: "lg" })}
            >
              Create free account
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-3 px-4 py-6 text-sm text-muted-foreground sm:flex-row md:px-6">
          <span>© {new Date().getFullYear()} Vibe Socials</span>
          <nav aria-label="Legal" className="flex items-center gap-4">
            <Link href="/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-foreground">
              Terms
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function Feature({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <span
        aria-hidden
        className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"
      >
        <Icon className="h-4.5 w-4.5" />
      </span>
      <h3 className="mt-3 text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function HowStep({
  index,
  icon: Icon,
  title,
  description,
}: {
  index: number;
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <li className="flex flex-col items-center rounded-xl border border-border bg-card p-5 text-center">
      <span
        aria-hidden
        className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary"
      >
        <Icon className="h-4.5 w-4.5" />
      </span>
      <span className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Step {index}
      </span>
      <h3 className="mt-1 text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </li>
  );
}
