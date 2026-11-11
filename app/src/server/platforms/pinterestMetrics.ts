import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { PINTEREST_API_BASE_URL } from "@/lib/pinterestApi";

import {
  NO_COUNTS,
  SOCIAL_METRICS_TIMEOUT_MS,
  countOf,
  emptyBatch,
  rawCounts,
  type PostMetricsBatch,
} from "./facebookMetrics";
import { classifyRateLimit } from "./rateLimited";

/**
 * Pinterest Pin numbers (2026-11-10), read once a day by socialPostMetricsSync
 * with the token the app already holds.
 *
 * GET /v5/pins/{pin_id}/analytics?start_date&end_date&metric_types=IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK
 * Security: pins:read and boards:read (both held, oauthScopes.ts). `start_date`
 * "Cannot be more than 90 days back from today", `end_date` "Cannot be more than
 * 90 days past start_date". `summary_metrics` holds each metric over the range:
 * IMPRESSION -> views, SAVE -> saves, PIN_CLICK -> clicks. OUTBOUND_CLICK (clicks
 * through to the website) is kept in `raw` only. The range runs from the
 * publish day, so the summary is the Pin's numbers since it went up.
 *
 * GET /v5/pins/analytics takes up to 100 Pins, but "is currently in beta and
 * not available to all apps", so each Pin is one request. The stored
 * `externalPostId` is the id POST /pins answers (pinterestClient.ts).
 *
 * The answer is keyed by app type; with app_types left at its default (ALL) the
 * one entry is read whatever its key.
 * https://github.com/pinterest/api-description v5/openapi.yaml 5.28.0 (read 2026-11-10)
 */

const METRIC_TYPES = ["IMPRESSION", "SAVE", "PIN_CLICK", "OUTBOUND_CLICK"] as const;
const DAY_MS = 86_400_000;
/** One day inside Pinterest's 90, so a small clock difference cannot push start_date past it. */
const MAX_DAYS_BACK = 89;

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** From the publish day (at most MAX_DAYS_BACK days back) to today, UTC. */
export function pinAnalyticsRange(publishedAt: Date, now: Date): { start: string; end: string } {
  const end = dayKey(now.getTime());
  const earliest = Date.parse(`${end}T00:00:00.000Z`) - MAX_DAYS_BACK * DAY_MS;
  const start = dayKey(Math.min(Math.max(publishedAt.getTime(), earliest), now.getTime()));
  return { start, end };
}

export interface PinRef {
  id: string;
  publishedAt: Date;
}

function summaryOf(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const entry = (record.all ?? record.ALL ?? Object.values(record)[0]) as { summary_metrics?: unknown } | undefined;
  const summary = entry?.summary_metrics;
  return summary && typeof summary === "object" ? (summary as Record<string, unknown>) : null;
}

/**
 * The numbers of `pins`, one request each, in order, until Pinterest limits the
 * rate or `shouldStop()` says the run's time is up; the Pins not reached are
 * `unchecked`. Best effort, never throws.
 */
export async function fetchPinterestPinMetricsBatch(
  pins: PinRef[],
  accessToken: string,
  now: Date,
  shouldStop: () => boolean = () => false,
): Promise<PostMetricsBatch> {
  const batch = emptyBatch();

  for (const [index, pin] of pins.entries()) {
    if (batch.rateLimited || shouldStop()) {
      for (const rest of pins.slice(index)) batch.unchecked.add(rest.id);
      break;
    }
    const { start, end } = pinAnalyticsRange(pin.publishedAt, now);
    const url = new URL(`${PINTEREST_API_BASE_URL}/pins/${encodeURIComponent(pin.id)}/analytics`);
    url.searchParams.set("start_date", start);
    url.searchParams.set("end_date", end);
    url.searchParams.set("metric_types", METRIC_TYPES.join(","));

    try {
      const response = await fetchWithTimeout(
        url.toString(),
        { headers: { Authorization: `Bearer ${accessToken}` } },
        SOCIAL_METRICS_TIMEOUT_MS,
      );
      if (await classifyRateLimit("pinterest", response)) {
        batch.rateLimited = true;
        batch.unchecked.add(pin.id);
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status !== 404) {
          console.error("[PostMetrics] Pinterest Pin analytics refused", { status: response.status });
          batch.failed.add(pin.id);
        }
        continue;
      }
      const summary = summaryOf(await response.json());
      if (!summary) continue;
      const numbers = {
        IMPRESSION: countOf(summary.IMPRESSION),
        SAVE: countOf(summary.SAVE),
        PIN_CLICK: countOf(summary.PIN_CLICK),
        OUTBOUND_CLICK: countOf(summary.OUTBOUND_CLICK),
      };
      batch.byId.set(pin.id, {
        counts: { ...NO_COUNTS, views: numbers.IMPRESSION, saves: numbers.SAVE, clicks: numbers.PIN_CLICK },
        raw: rawCounts(numbers),
        asked: ["views", "saves", "clicks"],
      });
    } catch (error) {
      console.error("[PostMetrics] Pinterest Pin analytics failed", {
        error: error instanceof Error ? error.name : "unknown",
        code: (error as { code?: unknown } | null)?.code,
      });
      batch.failed.add(pin.id);
    }
  }
  return batch;
}
