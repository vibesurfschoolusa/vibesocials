# Dependency Upgrade Plan (Health track H2)

**Status:** Plan only — **no major upgrades were applied autonomously.** Snapshot date: 2026‑07‑10, on `feat/roadmap`.

## Why this is a plan, not a diff

The roadmap build ran headless with **no database and no production environment** to smoke‑test against. Minor/patch bumps inside existing semver ranges are safe to apply and CI‑gate. But the **major** bumps below touch the ORM (Prisma), the background‑job engine (Inngest), auth (next‑auth), and the type/lint toolchain — a subtle regression in any of these can pass `tsc`/`build`/`vitest` and still break at runtime in production. Applying them blind in a branch headed for your prod is the wrong risk. Do them **one at a time, each on its own branch, each CI‑gated and prod‑smoke‑tested**, in the order below.

## Current → latest (from `npm outdated`, 2026‑07‑10)

| Package | Current | Latest | Type | Risk |
|---|---|---|---|---|
| `prisma` / `@prisma/client` | 6.19.3 | **7.8.0** | ORM major | **High** |
| `inngest` | 3.54.2 | **4.12.1** | jobs major | **High** |
| `next-auth` | 4.24.x | **5.x (Auth.js)** | auth major | **High** |
| `typescript` | 5.9.3 | **7.0.2** | lang major | Medium |
| `eslint` | 9.39.5 | **10.7.0** | lint major | Medium |
| `lucide-react` | 0.555.0 | **1.24.0** | icons major | Low‑med |
| `@types/node` | 20.19.x | **26.x** | types major | Low‑med |
| `next` | 16.1.1 | 16.2.10 | minor | Low |
| in‑range patches (`@prisma/client`→6.19.3, `tailwindcss`/`@tailwindcss/postcss`→4.3.2, `eslint`→9.39.5, `@vercel/blob`→2.6.1, `@types/react`→19.2.17) | — | — | patch/minor | **Safe** |

## Step 0 — safe in‑range updates (do first, low risk)

```
cd app
npm update        # applies the ^-range patch/minor bumps in the table's last row
npx prisma generate && npx tsc --noEmit && npx eslint . && npm run build && npx vitest run
```
Commit if green. These stay within the declared ranges (what a fresh `npm ci` would already resolve), so risk is minimal — but still gate them.

## Step 1 — `next` 16.1 → 16.2 (minor, low risk)
Same‑major minor. Read the 16.2 release notes for App‑Router behavior changes, bump, full gate + a manual click‑through of the core flows (compose → publish, queue, settings, dashboard).

## Step 2 — `eslint` 9 → 10 (medium)
Flat‑config major. Expect rule/preset changes; `eslint-config-next` must have a v10‑compatible release first (currently pinned to the Next line). Bump, run `npx eslint .`, fix any newly‑surfaced errors (do not mass‑disable), gate.

## Step 3 — `lucide-react` 0.x → 1.x and `@types/node` 20 → 26 (low‑med, isolated)
Icon renames/removals can break imports — grep every `lucide-react` import after bumping. `@types/node` 26 is types‑only but can surface stricter Node typings; `tsc` will flag them. One at a time.

## Step 4 — `typescript` 5 → 7 (medium, isolated)
A TS major can newly‑reject code that previously compiled. Bump alone, run `tsc`, fix type errors at the source (no `any`, no blanket `@ts‑ignore`). Confirm the Next build still type‑checks.

## Step 5 — the three high‑risk majors, each ALONE, prod‑smoke‑tested

Do **not** batch these. Each on its own branch, full gate, then deploy to a **preview/staging** and exercise real flows before prod.

- **Prisma 6 → 7.** Migration‑engine + client API changes. Verify: `prisma generate`; **`prisma migrate deploy` against a staging DB** (all the roadmap migrations under `app/prisma/migrations/`); every query path (the `$transaction` + `SELECT … FOR UPDATE` row locks in `posting.ts` / the media DELETE / the retention sweep, the `upsert`s, the `updateMany` atomic claims in scheduling). Read the v7 upgrade guide for `Json`/`BigInt`/enum handling and any client‑extension API changes.
- **Inngest 3 → 4.** The app leans on `createFunction`, `step.run` / `step.sendEvent`, `cron` triggers, `concurrency.key`, `retries`, and step memoization (`scheduledPostScanner`, `youtubePostMetricsSync`, `publishToAllPlatforms`, `retryPlatforms`, `sendNotification`). Re‑verify each against the v4 API, and confirm the `/api/inngest` route handler + `maxDuration` still hold. This is the highest‑leverage risk — the whole publish/schedule/notify/metrics backend runs on it.
- **next-auth 4 → 5 (Auth.js).** A near‑rewrite (config shape, session/callback API, middleware). Verify login/register/session on every protected route and the OAuth connection callbacks. Consider deferring unless there's a concrete need — v4 is stable here.

## General procedure per bump
1. Branch from the (merged) roadmap base. 2. Bump exactly one package. 3. `prisma generate; tsc --noEmit; eslint .; npm run build; vitest run`. 4. Manual smoke of the core flows on a preview deploy. 5. Merge only if all green. 6. Never mass‑disable lint/types to "make it pass" — fix the cause.

## Non‑goals
Do not chase `latest` for its own sake. `next-auth` 5 and `inngest` 4 in particular should be driven by a concrete need, not novelty — the current versions are stable in this app.
