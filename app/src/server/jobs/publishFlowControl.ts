/**
 * Flow control for the publish functions (2026-11-01 scale audit, jobs H1).
 *
 * `publishToAllPlatforms` and `retryPlatforms` draw on the SAME two env-scoped
 * concurrency keys, so a burst of publishes and a burst of retries share one
 * budget instead of each getting its own. A limit counts EXECUTING steps, not
 * runs, and a run sleeping in `sleepUntil` frees its slot.
 * https://www.inngest.com/docs/guides/concurrency
 *
 * - Inngest allows at most TWO concurrency constraints per function, and
 *   `scope: "env"` shares a limit across functions by the evaluated key. A
 *   constant key such as `'"publish-global"'` is allowed.
 * - Priority is a CEL expression evaluating to -600..600 seconds, applied within
 *   one function; an invalid expression evaluates to 0.
 *   https://www.inngest.com/docs/guides/priority
 *
 * Both limits are tunable by env (`.env.example`) and take effect at the next
 * deploy / function sync.
 */

/**
 * Concurrent publish steps per workspace (ruling R19: raised from 5).
 *
 * 20 drains a ~300-post single-workspace burst (~1,200 steps of ~40 s) in about
 * 40 minutes, well inside the 2 h stuck-in_progress reconciler. At 5 (~450
 * steps an hour, ~2.7 h for that burst) queued runs, which write no heartbeat,
 * were failed PUBLISH_STALLED by `reconcileStuckInProgressJobs` before their run
 * got a slot, and then skipped every platform when it finally started. It still
 * caps one workspace at 25% of the global slots.
 *
 * Per-account platform limits are not this limit's job: a rate-limited platform
 * (TikTok `video/init`: 6 requests per minute per user token,
 * https://developers.tiktok.com/doc/content-posting-api-reference-direct-post;
 * X: 100 posts per 15 min per user, https://docs.x.com/x-api/fundamentals/rate-limits)
 * answers 429, and the rate-limit deferral planned for the platform clients (Task 5)
 * turns that into a delay instead of a failure.
 */
export const DEFAULT_PUBLISH_CONCURRENCY_PER_WORKSPACE = 20;

/**
 * Concurrent publish steps across the whole environment: 80% of the 100
 * concurrent steps Inngest Pro includes
 * (https://www.inngest.com/docs/usage-limits/inngest). The rest stays free for
 * the scanner, notifications, `refresh-connection` and the sweeps. A 500-post
 * burst (~2,000 steps of ~40 s each) drains in about 17 minutes at this limit;
 * buying slots and raising `PUBLISH_CONCURRENCY_GLOBAL` is the lever.
 */
export const DEFAULT_PUBLISH_CONCURRENCY_GLOBAL = 80;

export interface PublishConcurrencyLimits {
  perWorkspace: number;
  global: number;
}

/** A positive integer from an env value, else `fallback` (missing, empty, zero, negative, fractional, junk). */
function positiveInteger(raw: string | undefined, fallback: number): number {
  const text = raw?.trim();
  if (!text || !/^\d+$/.test(text)) return fallback;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

/**
 * The two limits, from `PUBLISH_CONCURRENCY_PER_WORKSPACE` and
 * `PUBLISH_CONCURRENCY_GLOBAL`. Each falls back to its default on a missing or
 * invalid value (positive integers only), so a typo in the env never disables
 * flow control.
 */
export function publishConcurrencyLimits(
  env: Record<string, string | undefined> = process.env,
): PublishConcurrencyLimits {
  return {
    perWorkspace: positiveInteger(
      env.PUBLISH_CONCURRENCY_PER_WORKSPACE,
      DEFAULT_PUBLISH_CONCURRENCY_PER_WORKSPACE,
    ),
    global: positiveInteger(env.PUBLISH_CONCURRENCY_GLOBAL, DEFAULT_PUBLISH_CONCURRENCY_GLOBAL),
  };
}

type EnvScopedConcurrency = { scope: "env"; key: string; limit: number };

/**
 * The `concurrency` option of both publish functions: one key per workspace and
 * one global key. An event enqueued before this shipped has no `workspaceId`;
 * the global key still caps it (Inngest's handling of the missing field in the
 * per-workspace key is unconfirmed, and affects only events already queued at
 * deploy time).
 */
export function publishConcurrency(
  limits: PublishConcurrencyLimits = publishConcurrencyLimits(),
): [EnvScopedConcurrency, EnvScopedConcurrency] {
  return [
    { scope: "env", key: '"publish-ws-" + event.data.workspaceId', limit: limits.perWorkspace },
    { scope: "env", key: '"publish-global"', limit: limits.global },
  ];
}

/**
 * "Post now" jumps up to 10 minutes of scheduled backlog (600 is the maximum a
 * priority expression may return). No separate key is needed: priority orders
 * the backlog the shared concurrency keys create.
 */
export const PUBLISH_PRIORITY = { run: "event.data.immediate == true ? 600 : 0" } as const;
