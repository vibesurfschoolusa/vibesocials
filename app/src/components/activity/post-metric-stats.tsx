import {
  Bookmark,
  Eye,
  MessageCircle,
  MousePointerClick,
  Share2,
  ThumbsUp,
  type LucideIcon,
} from "lucide-react";

import type { Platform } from "@prisma/client";

import { platformLabel } from "@/lib/platforms";
import type { PostJobResultDTO, PostMetricDTO } from "@/lib/postsDto";

/**
 * Platforms whose numbers are read once a day (server/jobs/socialMetricsSync.ts).
 * Kept here, not imported from postsDto.ts: client code takes only types from it.
 */
const DAILY_METRIC_PLATFORMS: readonly Platform[] = ["instagram", "facebook_page", "linkedin", "pinterest"];

/** Format a count for display: thousands-separated, or "—" when null (never 0). */
function formatCount(value: number | null): string {
  return value == null ? "—" : value.toLocaleString();
}

interface StatProps {
  icon: LucideIcon;
  label: string;
  value: number | null;
}

function Stat({ icon: Icon, label, value }: StatProps) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="font-medium tabular-nums text-foreground">{formatCount(value)}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

/**
 * Roadmap Phase 8 — per-post engagement stats for a successful YouTube result.
 * Views / likes / comments, with "—" for any count not yet fetched (or hidden by
 * the creator). Purely presentational; the parent decides when to render it
 * (only for successful YouTube results).
 */
/** The numbers the daily platforms can carry, in the order they are shown. */
const DAILY_STATS: Array<{ key: keyof Omit<PostMetricDTO, "fetchedAt">; label: string; icon: LucideIcon }> = [
  { key: "views", label: "views", icon: Eye },
  { key: "likes", label: "likes", icon: ThumbsUp },
  { key: "comments", label: "comments", icon: MessageCircle },
  { key: "shares", label: "shares", icon: Share2 },
  { key: "clicks", label: "clicks", icon: MousePointerClick },
  { key: "saves", label: "saves", icon: Bookmark },
];

type DailyResult = PostJobResultDTO & { metric: PostMetricDTO };

/**
 * The results whose numbers the card shows for the daily platforms
 * (Instagram, Facebook, LinkedIn, Pinterest): successful, with an id, and with
 * at least one stored number.
 */
export function dailyMetricResults(results: PostJobResultDTO[]): DailyResult[] {
  return results.filter(
    (result): result is DailyResult =>
      DAILY_METRIC_PLATFORMS.includes(result.platform) &&
      result.status === "success" &&
      Boolean(result.externalPostId) &&
      result.metric !== null &&
      DAILY_STATS.some(({ key }) => result.metric?.[key] != null),
  );
}

/**
 * 2026-11-10: the numbers of the daily platforms, one row per platform, each
 * number only when the platform gave it, then one line saying how fresh they
 * are. Renders nothing when there is nothing to show.
 */
export function DailyMetricStats({ results }: { results: PostJobResultDTO[] }) {
  const shown = dailyMetricResults(results);
  if (shown.length === 0) return null;
  return (
    <div className="mt-3 space-y-1 text-xs">
      {shown.map((result) => (
        <div
          key={result.platform}
          role="group"
          aria-label={`${platformLabel(result.platform)} numbers`}
          className="flex flex-wrap items-center gap-x-4 gap-y-1"
        >
          <span className="font-medium text-foreground">{platformLabel(result.platform)}</span>
          {DAILY_STATS.filter(({ key }) => result.metric[key] != null).map(({ key, label, icon }) => (
            <Stat key={key} icon={icon} label={label} value={result.metric[key]} />
          ))}
        </div>
      ))}
      <p className="text-muted-foreground">Updated once a day.</p>
    </div>
  );
}

export function PostMetricStats({ metric }: { metric: PostMetricDTO | null }) {
  return (
    <div
      role="group"
      aria-label="YouTube engagement"
      className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
    >
      <Stat icon={Eye} label="views" value={metric?.views ?? null} />
      <Stat icon={ThumbsUp} label="likes" value={metric?.likes ?? null} />
      <Stat icon={MessageCircle} label="comments" value={metric?.comments ?? null} />
    </div>
  );
}
