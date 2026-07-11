import { Eye, MessageCircle, ThumbsUp, type LucideIcon } from "lucide-react";

import type { PostMetricDTO } from "@/lib/postsDto";

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
