import { CheckCircle2, Clock, XCircle, type LucideIcon } from "lucide-react";
import type { Platform, PostJobResultStatus } from "@prisma/client";

import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { platformLabel } from "@/lib/platforms";

const RESULT_META: Record<
  PostJobResultStatus,
  { variant: BadgeVariant; icon: LucideIcon; srLabel: string }
> = {
  success: { variant: "success", icon: CheckCircle2, srLabel: "posted" },
  failed: { variant: "danger", icon: XCircle, srLabel: "failed" },
  pending: { variant: "neutral", icon: Clock, srLabel: "pending" },
};

/**
 * A per-platform result pill: platform name + a status icon and color. The
 * status word is exposed to assistive tech via an sr-only suffix so the meaning
 * never depends on color alone.
 */
export function PlatformResultBadge({
  platform,
  status,
}: {
  platform: Platform;
  status: PostJobResultStatus;
}) {
  const meta = RESULT_META[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon aria-hidden className="h-3.5 w-3.5" />
      <span>{platformLabel(platform)}</span>
      <span className="sr-only"> — {meta.srLabel}</span>
    </Badge>
  );
}
