# Publish Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publishes survive transient platform blips (bounded in-step retries), and dying platform connections are detected and emailed about proactively — before a scheduled post fails.

**Architecture:** Two independent additions. (1) A pure transient-error classifier + bounded retry helper wrapped around each platform client's `publishVideo` call inside the existing `publish-to-<platform>` Inngest step — the function stays `retries: 0`, so retry policy is explicit and double-post-safe. (2) A daily `connectionHealthSweep` Inngest cron that proactively refreshes soon-to-expire/stale tokens via each client's existing `refreshToken` method; a terminal refresh failure already flips `needsReconnect` inside the clients, and the sweep emails workspace owners exactly on that transition.

**Tech Stack:** TypeScript, Next.js app dir, Prisma, Inngest, Vitest, Resend (via existing fail-safe `sendEmail`).

## Global Constraints

- Repo convention: pure decision logic lives in small modules with table-driven Vitest tests; Inngest functions stay thin wrappers (see `stalePostJobs.ts` + `stalePostJobSweep`).
- NEVER serialize OAuth tokens through `step.run()` return values (SEC invariant in `inngest-functions.ts`).
- NEVER overwrite `SocialConnection.refreshToken` (invariant pinned in `googleTokens.ts`).
- `sendEmail` (`src/server/notifications/email.ts`) never throws; callers fire-and-forget.
- Cron slots already taken: `0 3 * * *` (media retention), `* * * * *` (scheduled scanner), `0 * * * *` (youtube metrics), `30 * * * *` (stale post jobs). This plan uses `45 4 * * *`.
- `publishToAllPlatforms` MUST stay `retries: 0` — Inngest-level retries can double-post.
- Retry policy (double-post safety): retry ONLY errors where the request provably did not commit — HTTP 429/5xx responses (the platform answered with a failure) and pre-response network failures (`TypeError` from fetch). NEVER retry `FETCH_TIMEOUT` (`src/lib/fetchWithTimeout.ts` — request may have committed server-side), never 4xx, never token errors.
- New Inngest functions must be added to the `inngestFunctions` export array in `src/server/jobs/inngest-functions.ts` AND the cron-cadence map comment in this plan's tasks; deploy auto-syncs via `.github/workflows/inngest-sync.yml`.
- Commit style: `<type>(scope): summary` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. One PR per task, branch names `feat/transient-publish-retry` and `feat/connection-health-sweep`.

---

### Task 1: Transient publish retry

**Files:**
- Modify: `app/src/lib/assertOk.ts` (attach `error.status`)
- Modify: `app/src/lib/assertOk.test.ts` (new assertion)
- Create: `app/src/server/platforms/transientRetry.ts`
- Create: `app/src/server/platforms/transientRetry.test.ts`
- Modify: `app/src/server/jobs/inngest-functions.ts:145` (wrap `client.publishVideo`)

**Interfaces:**
- Consumes: `assertOk` (all platform clients throw its errors), `FETCH_TIMEOUT_CODE` from `@/lib/fetchWithTimeout`.
- Produces: `isTransientPublishError(error: unknown): boolean` and `withTransientRetries<T>(fn: () => Promise<T>, opts?: { attempts?: number; sleep?: (ms: number) => Promise<void> }): Promise<T>` from `@/server/platforms/transientRetry`. `assertOk` errors additionally carry `status: number`.

- [ ] **Step 1: Write the failing test for `assertOk` carrying `status`**

Append to `app/src/lib/assertOk.test.ts` (match the file's existing test style — read it first):

```typescript
it("attaches the HTTP status to the thrown error for retry classification", async () => {
  const res = new Response("upstream body", { status: 503 });
  const err = await assertOk(res, { code: "X_FAILED", prefix: "Upload failed" }).catch(
    (e) => e as Error & { status?: number },
  );
  expect(err.status).toBe(503);
});
```

- [ ] **Step 2: Run it — must FAIL** (`npx vitest run src/lib/assertOk.test.ts` in `app/`; expect `status` undefined)

- [ ] **Step 3: Implement** — in `assertOk.ts`, change the error construction to:

```typescript
  const error = new Error(`${prefix} (status ${res.status})`) as Error & {
    code: string;
    status: number;
  };
  error.code = code;
  error.status = res.status;
  throw error;
```

Also update the doc comment: the thrown error carries `code` and `status` (numeric HTTP status, used by `server/platforms/transientRetry.ts` to classify retryable failures).

- [ ] **Step 4: Run the test — PASS**; run the FULL suite (`npm test`) — platform-client tests assert on `code`/`message`, not enumerated keys, so nothing else should break. If something does, fix the test expectations only if they over-specify (e.g. `toEqual` on the whole error).

- [ ] **Step 5: Write failing tests for the classifier + retry helper**

Create `app/src/server/platforms/transientRetry.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";

import { isTransientPublishError, withTransientRetries } from "./transientRetry";

function statusError(status: number): Error & { status: number } {
  const e = new Error(`failed (status ${status})`) as Error & { status: number };
  e.status = status;
  return e;
}

describe("isTransientPublishError", () => {
  it("treats 429 and 5xx platform responses as transient", () => {
    expect(isTransientPublishError(statusError(429))).toBe(true);
    expect(isTransientPublishError(statusError(500))).toBe(true);
    expect(isTransientPublishError(statusError(503))).toBe(true);
  });

  it("treats pre-response network failures (fetch TypeError) as transient", () => {
    expect(isTransientPublishError(new TypeError("fetch failed"))).toBe(true);
  });

  it("never retries timeouts — the request may have committed", () => {
    const e = new Error("Request timed out after 30000ms") as Error & { code: string };
    e.code = FETCH_TIMEOUT_CODE;
    expect(isTransientPublishError(e)).toBe(false);
  });

  it("never retries non-429 4xx (auth/validation) or token errors", () => {
    expect(isTransientPublishError(statusError(400))).toBe(false);
    expect(isTransientPublishError(statusError(401))).toBe(false);
    expect(isTransientPublishError(statusError(403))).toBe(false);
    const tokenErr = new Error("refresh failed") as Error & { code: string };
    tokenErr.code = "GOOGLE_TOKEN_REFRESH_FAILED";
    expect(isTransientPublishError(tokenErr)).toBe(false);
  });

  it("does not retry unknown plain errors", () => {
    expect(isTransientPublishError(new Error("something else"))).toBe(false);
    expect(isTransientPublishError(undefined)).toBe(false);
  });
});

describe("withTransientRetries", () => {
  it("returns the first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withTransientRetries(fn, { sleep: async () => {} })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(statusError(503))
      .mockResolvedValueOnce("ok");
    await expect(withTransientRetries(fn, { sleep: async () => {} })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 total attempts and rethrows the LAST error", async () => {
    const fn = vi.fn().mockRejectedValue(statusError(502));
    await expect(withTransientRetries(fn, { sleep: async () => {} })).rejects.toMatchObject({
      status: 502,
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows a non-transient failure immediately", async () => {
    const fn = vi.fn().mockRejectedValue(statusError(401));
    await expect(withTransientRetries(fn, { sleep: async () => {} })).rejects.toMatchObject({
      status: 401,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("backs off between attempts (2s then 8s)", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(statusError(500));
    await withTransientRetries(fn, { sleep: async (ms) => { delays.push(ms); } }).catch(() => {});
    expect(delays).toEqual([2000, 8000]);
  });
});
```

- [ ] **Step 6: Run it — must FAIL** (module doesn't exist)

- [ ] **Step 7: Implement `app/src/server/platforms/transientRetry.ts`**

```typescript
import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";

/**
 * Should this publish-path failure be retried in-step?
 *
 * YES — the request provably did not commit on the platform:
 *  - HTTP 429 / 5xx responses (`assertOk` attaches `status`)
 *  - pre-response network failures (undici fetch rejects with TypeError)
 *
 * NO — everything else, deliberately:
 *  - FETCH_TIMEOUT: the platform may have received and committed the request;
 *    retrying risks a double post. (fetchWithTimeout's timer only covers
 *    connection + headers, but that is exactly the ambiguous window.)
 *  - 4xx (except 429): auth/validation — retrying cannot help.
 *  - token/reconnect error codes: terminal until the user reconnects.
 */
export function isTransientPublishError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== "object") return false;
  const err = error as { status?: unknown; code?: unknown };
  if (err.code === FETCH_TIMEOUT_CODE) return false;
  if (typeof err.status === "number") {
    return err.status === 429 || err.status >= 500;
  }
  return false;
}

/** Backoff schedule between attempts: attempt1 --2s--> attempt2 --8s--> attempt3. */
const BACKOFF_MS = [2_000, 8_000] as const;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying ONLY transient failures (see isTransientPublishError),
 * up to 3 total attempts with 2s/8s backoff. Non-transient errors and the
 * final transient error are rethrown unchanged so `PostJobResult.errorCode`
 * / `errorMessage` keep their existing meaning.
 *
 * Lives OUTSIDE Inngest's retry machinery on purpose: `publishToAllPlatforms`
 * is `retries: 0` because function-level replays can double-post; this helper
 * bounds retries to the one platform call that provably failed.
 */
export async function withTransientRetries<T>(
  fn: () => Promise<T>,
  opts?: { sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = opts?.sleep ?? realSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientPublishError(error) || attempt === BACKOFF_MS.length) {
        throw error;
      }
      await sleep(BACKOFF_MS[attempt]);
    }
  }
  throw lastError; // unreachable; satisfies control-flow analysis
}
```

- [ ] **Step 8: Run the new test file — PASS**

- [ ] **Step 9: Wire into the publisher** — in `app/src/server/jobs/inngest-functions.ts`, add import `import { withTransientRetries } from "@/server/platforms/transientRetry";` and change line 145 (`publishToPlatform`) from:

```typescript
    const publishResult = await client.publishVideo(publishContext);
```

to:

```typescript
    // Bounded in-step retry for provably-uncommitted transient failures
    // (429/5xx/pre-response network errors). See transientRetry.ts for why
    // timeouts and 4xx are deliberately excluded and why this must NOT be
    // an Inngest-level retry.
    const publishResult = await withTransientRetries(() =>
      client.publishVideo(publishContext),
    );
```

There is a SECOND call site in the retry flow (`retry-${platform}` step, around line 643) — find `client.publishVideo` occurrences and wrap ALL of them the same way.

- [ ] **Step 10: Full verification** — `npm test` (all green), `npx tsc --noEmit`, `npx eslint .` in `app/`.

- [ ] **Step 11: Commit + PR** — branch `feat/transient-publish-retry`, commit `feat(publish): retry transient platform failures in-step`, PR explaining the double-post-safety policy, wait for CI, squash-merge.

---

### Task 2: Connection health sweep + proactive reconnect email

**Files:**
- Create: `app/src/server/jobs/connectionHealthSweep.ts`
- Create: `app/src/server/jobs/connectionHealthSweep.test.ts`
- Create: `app/src/server/notifications/reconnectEmail.ts`
- Create: `app/src/server/notifications/reconnectEmail.test.ts`
- Modify: `app/src/server/jobs/inngest-functions.ts` (new cron function + add to `inngestFunctions` array)

**Interfaces:**
- Consumes: `getPlatformClient(platform)` (from `@/server/platforms` — returns `PlatformClient | null`, whose optional `refreshToken(connection)` persists the refreshed token itself and, on terminal failure, flips `needsReconnect` via `markConnectionNeedsReconnect` before throwing), `sendEmail` from `@/server/notifications/email`, `platformLabel` from `@/lib/platforms`.
- Produces: `REFRESH_HORIZON_MS` (24h) and `isProactiveRefreshEligible(connection: { needsReconnect: boolean; expiresAt: Date | string | null }, now: Date): boolean` from `@/server/jobs/connectionHealthSweep`; `buildReconnectEmail(params: { platformLabel: string; workspaceName: string }): { subject: string; html: string }` from `@/server/notifications/reconnectEmail`; Inngest cron `connection-health-sweep` at `45 4 * * *`.

- [ ] **Step 1: Write failing tests for the eligibility rule**

Create `app/src/server/jobs/connectionHealthSweep.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  REFRESH_HORIZON_MS,
  isProactiveRefreshEligible,
} from "./connectionHealthSweep";

const NOW = new Date("2026-07-26T12:00:00.000Z");

function conn(overrides: Partial<{ needsReconnect: boolean; expiresAt: Date | null }> = {}) {
  return { needsReconnect: false, expiresAt: new Date("2026-04-01T00:00:00Z"), ...overrides };
}

describe("isProactiveRefreshEligible", () => {
  it("refreshes a token already expired", () => {
    expect(isProactiveRefreshEligible(conn(), NOW)).toBe(true);
  });

  it("refreshes a token expiring within the 24h horizon", () => {
    const expiresAt = new Date(NOW.getTime() + REFRESH_HORIZON_MS - 60_000);
    expect(isProactiveRefreshEligible(conn({ expiresAt }), NOW)).toBe(true);
  });

  it("skips a token with plenty of life left", () => {
    const expiresAt = new Date(NOW.getTime() + REFRESH_HORIZON_MS + 60_000);
    expect(isProactiveRefreshEligible(conn({ expiresAt }), NOW)).toBe(false);
  });

  it("skips connections already flagged needsReconnect (owner already notified)", () => {
    expect(isProactiveRefreshEligible(conn({ needsReconnect: true }), NOW)).toBe(false);
  });

  it("skips connections with no expiry at all (e.g. X OAuth1 — nothing to refresh)", () => {
    expect(isProactiveRefreshEligible(conn({ expiresAt: null }), NOW)).toBe(false);
  });

  it("accepts ISO-string expiresAt (step.run serialization)", () => {
    expect(
      isProactiveRefreshEligible(
        { needsReconnect: false, expiresAt: "2026-04-01T00:00:00.000Z" as unknown as Date },
        NOW,
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run — must FAIL** (module missing)

- [ ] **Step 3: Implement `app/src/server/jobs/connectionHealthSweep.ts`**

```typescript
/**
 * Connection health sweep — pure eligibility rule.
 *
 * Which connections should the daily cron proactively try to refresh?
 *  - `needsReconnect` false: a flagged connection is already dead and its
 *    owner already got the reconnect email (this sweep's transition email, or
 *    a failed-post email) — re-refreshing would just re-fail and re-spam.
 *  - `expiresAt` non-null and within REFRESH_HORIZON_MS of `now` (or past):
 *    refreshing daily keeps provider refresh-tokens alive (Google kills
 *    unused grants after ~6 months) and surfaces a dead grant TODAY instead
 *    of at the next scheduled post. Connections with `expiresAt: null`
 *    (e.g. X OAuth1) have nothing to refresh.
 *
 * The cron (inngest-functions.ts) attempts `client.refreshToken(connection)`
 * for each eligible connection; platform clients persist the new token and,
 * on terminal failure, flip `needsReconnect` themselves — the cron emails
 * workspace owners exactly when it observes that transition.
 */
export const REFRESH_HORIZON_MS = 24 * 60 * 60 * 1000;

export function isProactiveRefreshEligible(
  connection: { needsReconnect: boolean; expiresAt: Date | string | null },
  now: Date,
): boolean {
  if (connection.needsReconnect) return false;
  if (connection.expiresAt === null) return false;
  const expiresAt = new Date(connection.expiresAt);
  return expiresAt.getTime() < now.getTime() + REFRESH_HORIZON_MS;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Write failing tests for the email template**

Create `app/src/server/notifications/reconnectEmail.test.ts` (read `postOutcomeEmail.test.ts` first and match its style):

```typescript
import { describe, expect, it } from "vitest";

import { buildReconnectEmail } from "./reconnectEmail";

describe("buildReconnectEmail", () => {
  const email = buildReconnectEmail({
    platformLabel: "Google Business Profile",
    workspaceName: "Klaus Schroder's workspace",
  });

  it("names the platform in the subject", () => {
    expect(email.subject).toBe(
      "Action needed: reconnect Google Business Profile on Vibe Socials",
    );
  });

  it("says which workspace is affected and links to settings", () => {
    expect(email.html).toContain("Klaus Schroder&#39;s workspace");
    expect(email.html).toContain("https://vibesocials.wtf/settings");
  });

  it("explains the consequence (scheduled posts will fail) in plain language", () => {
    expect(email.html).toMatch(/scheduled posts .*(fail|can’t|cannot)/i);
  });

  it("escapes HTML in the workspace name", () => {
    const evil = buildReconnectEmail({
      platformLabel: "X",
      workspaceName: '<img src=x onerror=alert(1)>',
    });
    expect(evil.html).not.toContain("<img");
  });
});
```

- [ ] **Step 6: Run — must FAIL**

- [ ] **Step 7: Implement `app/src/server/notifications/reconnectEmail.ts`**

First read `postOutcomeEmail.ts` for its HTML-escaping helper and layout; reuse its conventions (if it exports an `escapeHtml`, import it; otherwise copy the same 5-entity escaper locally):

```typescript
/** Minimal HTML-entity escaper (same table as postOutcomeEmail.ts). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SETTINGS_URL = "https://vibesocials.wtf/settings";

/**
 * Proactive reconnect notice, sent by the connectionHealthSweep cron to every
 * OWNER of the workspace whose connection just terminally failed a token
 * refresh — BEFORE a scheduled post fails on it. Pure builder (tested);
 * transport is the fail-safe sendEmail().
 */
export function buildReconnectEmail(params: {
  platformLabel: string;
  workspaceName: string;
}): { subject: string; html: string } {
  const platform = escapeHtml(params.platformLabel);
  const workspace = escapeHtml(params.workspaceName);
  return {
    subject: `Action needed: reconnect ${params.platformLabel} on Vibe Socials`,
    html: [
      `<p>The ${platform} connection in <strong>${workspace}</strong> has stopped working — the platform rejected our renewal, which usually means the authorization was revoked or expired.</p>`,
      `<p>Until it is reconnected, new and scheduled posts to ${platform} will fail.</p>`,
      `<p><a href="${SETTINGS_URL}">Reconnect ${platform} in Settings</a> — it takes about a minute.</p>`,
      `<p>— Vibe Socials</p>`,
    ].join("\n"),
  };
}
```

- [ ] **Step 8: Run — PASS** (adjust only if the escaping/style borrowed from `postOutcomeEmail.ts` differs — keep the repo's convention, then make the test match the convention, not vice versa)

- [ ] **Step 9: Add the cron to `inngest-functions.ts`**

Add imports: `isProactiveRefreshEligible` from `./connectionHealthSweep`, `buildReconnectEmail` from `@/server/notifications/reconnectEmail`, `sendEmail` from `@/server/notifications/email` (check what's already imported — `platformLabel` may already be there). Then append (before the `inngestFunctions` array):

```typescript
/**
 * Daily connection-health sweep (publish-reliability plan, Task 2).
 *
 * Proactively refreshes every healthy connection whose access token is
 * expired or expiring within 24h (isProactiveRefreshEligible). This has two
 * effects: (1) provider refresh-tokens stay alive (Google revokes grants
 * unused for ~6 months — exactly how the prod GBP connection died on
 * 2026-07-26), and (2) a dead grant is discovered TODAY, flips
 * `needsReconnect` (the clients do that themselves via
 * markConnectionNeedsReconnect), and every workspace OWNER gets ONE
 * reconnect email — instead of the user discovering it when a scheduled
 * post fails.
 *
 * Email exactly-once: eligibility requires `needsReconnect === false`, so a
 * connection that flips is skipped by every later sweep; a transient network
 * failure during refresh leaves the flag false and is simply retried
 * tomorrow. Cron slot 04:45 UTC — see the cadence map: media-retention 03:00,
 * scheduled-scanner every minute, youtube-metrics hourly :00,
 * stale-post-sweep hourly :30.
 *
 * SEC: the step returns COUNTS only — never connection rows (tokens).
 */
export const connectionHealthSweep = inngest.createFunction(
  { id: "connection-health-sweep", name: "Connection Health Sweep" },
  { cron: "45 4 * * *" },
  async ({ step }) => {
    const summary = await step.run("refresh-expiring-connections", async () => {
      const now = new Date();
      const candidates = await prisma.socialConnection.findMany({
        where: { needsReconnect: false, expiresAt: { not: null } },
      });

      let attempted = 0;
      let refreshed = 0;
      let flagged = 0;
      let emailed = 0;

      for (const connection of candidates) {
        if (!isProactiveRefreshEligible(connection, now)) continue;
        const client = getPlatformClient(connection.platform);
        if (!client?.refreshToken) continue;

        attempted++;
        try {
          await client.refreshToken(connection);
          refreshed++;
        } catch {
          // Terminal failures already flipped needsReconnect inside the
          // client (markConnectionNeedsReconnect); transient ones did not.
          // Re-read the flag to distinguish — email ONLY on the flip.
          const after = await prisma.socialConnection.findUnique({
            where: { id: connection.id },
            select: { needsReconnect: true, workspaceId: true },
          });
          if (!after?.needsReconnect) continue;
          flagged++;

          const [workspace, owners] = await Promise.all([
            prisma.workspace.findUnique({
              where: { id: after.workspaceId },
              select: { name: true },
            }),
            prisma.workspaceMember.findMany({
              where: { workspaceId: after.workspaceId, role: "owner" },
              select: { user: { select: { email: true } } },
            }),
          ]);
          const email = buildReconnectEmail({
            platformLabel: platformLabel(connection.platform),
            workspaceName: workspace?.name ?? "your workspace",
          });
          for (const owner of owners) {
            // sendEmail never throws (fail-safe transport).
            await sendEmail({ to: owner.user.email, ...email });
            emailed++;
          }
        }
      }

      return { candidates: candidates.length, attempted, refreshed, flagged, emailed };
    });

    logger.info("[Inngest] Connection health sweep complete", summary);
    return summary;
  },
);
```

Then add `connectionHealthSweep` to the `inngestFunctions` array at the bottom of the file.

NOTE for the implementer: verify the exact import names first — `getPlatformClient` lives in `@/server/platforms` (see how `publishToPlatform` imports it), `platformLabel` in `@/lib/platforms`, `logger` and `prisma` are already imported in this file. If `User.email` is accessed differently in this repo's member queries, mirror the query shape used by an existing owner-email lookup (search `role: "owner"` under `src/app/api/workspaces`).

- [ ] **Step 10: Full verification** — `npm test`, `npx tsc --noEmit`, `npx eslint .` in `app/`. The existing test asserting cron-slot uniqueness (if any — search `30 \* \* \* \*` in tests) must still pass.

- [ ] **Step 11: Commit + PR** — branch `feat/connection-health-sweep`, commit `feat(connections): daily health sweep with proactive reconnect email`, PR body explaining transition-only emailing + the Google 6-month-grant motivation, CI green, squash-merge.

- [ ] **Step 12: Prod verification after deploy**
  1. Confirm the `Inngest sync` workflow ran on the merge deploy (it validates registration).
  2. `curl -s -X PUT https://vibesocials.wtf/api/inngest` → "Successfully registered" (belt and braces).
  3. Next morning (after 04:45 UTC), read-only prod DB check: the dead GBP connection stays `needsReconnect: true` (skipped, no email spam); a healthy connection with near expiry (if any) got `expiresAt` advanced. Vercel runtime logs show `[Inngest] Connection health sweep complete`.

---

## Self-Review (done at planning time)

- Spec coverage: transient retries → Task 1; proactive token health + owner email → Task 2. Weekly publish-health digest, calendar view, approvals, analytics are separate subsystems — separate future plans.
- Placeholder scan: none — all code inline.
- Type consistency: `withTransientRetries(fn, opts)` used in Task 1 Step 9 matches Step 7's signature; `isProactiveRefreshEligible(connection, now)` and `buildReconnectEmail({platformLabel, workspaceName})` match between tests, implementations, and the cron.
