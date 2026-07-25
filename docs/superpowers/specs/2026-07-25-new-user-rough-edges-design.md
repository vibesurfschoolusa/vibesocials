# New-user rough edges — design

**Date:** 2026-07-25
**Status:** approved, ready to implement

## Context

An open-ended quality sweep of the live app (`https://vibesocials.wtf`), driven in a
real browser with a throwaway account, to answer "does it work as expected and is it
nice to use?".

Most of it does. Verified working on prod: signup → auto-login → dashboard, login,
logout, settings save **and** persistence across reload, media upload writing to
Vercel Blob and appearing in the library, the `/connections` → `/settings` redirect,
queue/activity/media empty states, mobile at 390px with no horizontal overflow, and
dark mode across all six authed pages with no contrast or theming defects. The unit
suite is 771/771 green.

Four defects were found, all of which hit a **brand-new user** — the audience least
willing to forgive them. This spec covers those four. A fifth finding (dashboard CTA
redundancy: "Create post" appears three times and "Manage connections" twice on one
screen) was deliberately deferred: the fix is a subjective product decision about what
a new user's single next action should be, not a defect fix.

## F1 — Reviews shows a red error instead of an empty state

**Severity: high.** This is the worst moment in the app.

A user who has not connected Google Business Profile — i.e. every new user — clicks
"Reviews" in the nav and gets a red failure card reading *"Couldn't load reviews — No
Google Business Profile connection found"* with a **Retry** button that can never
succeed. It also emits a console error and a 404 on every visit.

The intended design already exists and is unreachable. `reviews-view.tsx` has a
well-written empty state for exactly this case ("Connect Google Business Profile" →
"Go to connections"), gated on `locations.length === 0`. It is dead code:
`src/app/api/reviews/locations/route.ts:29` returns **HTTP 404** when no connection
row exists, `loadLocations` treats any non-ok response as a thrown error, and the
component returns early at the red `ErrorState` before reaching the empty state.

**Fix.** "No connection" is a normal state, not a failure. The route returns `200`
with `{ locations: [], connected: false }` when no connection row exists, and adds
`connected: true` to its success payload. The client reads the flag and distinguishes
two zero-location cases that currently share one message:

- `connected: false` → existing copy: "Connect Google Business Profile" + "Go to
  connections" CTA.
- `connected: true`, zero locations → "No locations found", explaining the connected
  profile has no locations yet. No CTA — going to Settings would not help.

Genuine failures (expired token, Google API 5xx, network) still throw and still render
the red `ErrorState` with a working Retry. Only the "nothing connected yet" case
changes.

**Blast radius:** one consumer (`reviews-view.tsx:41`), no existing tests on the
route. The sibling routes that return the same 404 (`/api/reviews`,
`/api/reviews/[reviewId]/reply`, and the two under `/api/connections/`) are left
alone — they are only ever called once a location is selected, so their 404 is
correct and unreachable from the new-user path.

## F2 — Composer renders a form that can never be submitted

**Severity: medium.**

With zero connected platforms, `/posts/new` shows the "Connect a platform to start
posting" empty state and then, directly beneath it, the entire post form: file picker,
caption box, AI caption buttons, location search, and publish/schedule/draft controls.
Every submit path is disabled. The user can fill the whole thing in and get nowhere.

**Fix.** In `create-post-form.tsx`, when `connectionsResolved && connectedPlatforms
.length === 0`, return the empty state alone inside the existing `Card` and render no
form. The inline empty-state block at lines 749–760 is removed in favour of an early
return placed immediately before the current `return` (line 713) — after every hook
call, so hook order is unaffected.

This also covers the reuse flow (arriving from Media → "Use in new post" with no
connections): posting is equally impossible there, so the connect CTA is the correct
and only useful thing to show.

## F3 — 404 page is the unbranded Next.js default

**Severity: low.**

Any bad URL renders the stock `404 | This page could not be found.`, inside the app
shell, with no way back.

**Fix.** Add `src/app/not-found.tsx` — a branded `EmptyState` with a "Back to
dashboard" link, matching the empty states used elsewhere. It renders inside the
existing `AppShell` from the root layout, so signed-in users keep their nav.

## F4 — Unstyled file inputs

**Severity: low.** The one place the design system visibly breaks.

The two upload surfaces are styled inconsistently with each other — and not, as first
recorded here, because the composer is unstyled. Corrected on implementation:

- `create-post-form.tsx:805` is a bare `<input type="file">` that *does* carry its own
  `file:` rules, so its button reads as a secondary button — but it has no field
  border, so it floats on the page background.
- `media-library.tsx:362` uses the `Input` component, which draws a proper bordered
  field but has only minimal `file:` rules (`file:border-0 file:bg-transparent`), so
  the native "Choose File" button inside it renders raw.

**Fix.** Take the better half of each. Extend the `file:` styling in
`src/components/ui/input.tsx` so the file button reads as a secondary button
(`file:bg-secondary`, rounded, cursor-pointer, hover state) using existing theme
tokens — already defined for both light and dark. Then switch the composer's bare
input to the `Input` component and drop its now-duplicated inline classes, so both
surfaces are a bordered field containing a styled button. The file button's height is
kept inside the field's `h-10` so the control does not grow.

## Testing

- **F1:** new `src/app/api/reviews/locations/route.test.ts`, following the established
  colocated pattern (`vi.hoisted` + `vi.mock` of `@/lib/db` and `@/lib/workspace`,
  mirroring `api/settings/route.test.ts`). Cases: no connection → 200 /
  `connected: false` / empty locations; unauthorized → 401; connection present →
  `connected: true`.
- **F2, F3, F4:** presentational, with no component-test infrastructure in this repo
  (the suite is node-env `.test.ts` only). Verified by rendering the real pages in
  Playwright against the deployed build.
- Full unit suite must stay green (771 passing before this work).
- Each change is verified live on `https://vibesocials.wtf` after deploy, in light and
  dark, at desktop and 390px.

## Delivery

One PR per fix, each merged to `main` and deployed, matching the established pattern
in this repo. F1 first — it is the only user-visible bug.
