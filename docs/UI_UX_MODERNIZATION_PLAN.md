# Vibe Socials — UI/UX Modernization Audit & Plan

Status: DRAFT for execution. Authored 2026-07-10. Branch: `design/ui-ux-overhaul`.

This turns a full UI/UX audit of the app into a phased redesign program, in the same
delegate-and-review style as the completed security/correctness remediation. It is a
**visual and experience overhaul, not a functional rewrite** — every existing behavior
(API payloads, auth gates, OAuth flows, the rate limiter, grapheme truncation, settings
validation, the Phase-5 toast + reviews components) is preserved. Line references are
against the working tree at branch creation; re-verify as work lands.

---

## 1. Executive summary

**Where it is.** The app works but looks and navigates like an internal tool from ~2020.
It has no global navigation (every page is a standalone island reached by a "Back to
dashboard" text link), no design system (≈12 button and ≈8 card variants across three
clashing color "dialects"), a "dashboard" that is really a 4-link launcher, and — most
tellingly — **it never shows users the result of their own core action**: posts fan out to
6 platforms via a background job, but the per-platform success/failure data
(`PostJob`/`PostJobResult`, which already exists and has a GET endpoint) is never rendered.
Dark mode is declared in CSS but implemented nowhere. Five native `alert()`/`confirm()`
dialogs and a non-accessible modal remain.

**Where it should be.** A clean, modern, confident SaaS product in the shape of the
category leaders (Buffer, Later, Publer, Metricool) with the visual restraint of
Linear/Vercel: one persistent app shell, a real dashboard, a visible post-activity view, a
single coherent design system (light **and** dark), and accessible, responsive, mobile-first
flows. Gradients become a subtle brand accent, not the entire UI.

**How.** Five phases: (A) design foundation — tokens + primitive components; (B) app shell +
real dashboard + activity view; (C) migrate the core flows; (D) reviews/legal alignment +
dark mode + accessibility pass; (E) verification. Opus designs the foundation and the shell/
dashboard architecture and adversarially reviews each phase; Sonnet does bulk page migration
once the pattern is set. Disjoint work runs in parallel worktrees.

---

## 2. Audit findings

### 2.1 Structural (highest leverage)
- **No global navigation anywhere.** `layout.tsx` renders only the session provider; there
  is no nav/sidebar/topbar. Users bounce through the home hub to get between Create,
  Settings, Reviews. `/media` is orphaned (not linked from the hub at all).
- **The core output is invisible.** `PostJob.status` + per-platform
  `PostJobResult{status, externalPostId, errorCode, errorMessage}` exist and a
  `GET /api/posts/[postJobId]` endpoint returns them, but **no UI consumes it**. After
  posting, the user sees only `Post created (job <cuid>).` and never learns whether TikTok,
  YouTube, etc. succeeded. This is the single biggest product gap.
- **The dashboard is a launcher, not a dashboard.** `/` is one card with 3–4 link buttons.
- **A dead page in the flow.** `/connections` renders a "moved to settings" card instead of
  `redirect()`-ing, and `reviews/error-state.tsx` links users *into* it — a dead loop.

### 2.2 No design system
- **~12–15 distinct button treatments** (5 different primary fills alone), **~8 card
  treatments**, 5 focus-ring styles, 4 page-background gradients, `gray-*` and `zinc-*` used
  interchangeably. Three visual dialects coexist: marketing/auth (blue→teal gradients),
  "zinc/black admin" (create-post, media, settings panels), and "flat blue" (reviews).
- **Only one reusable primitive exists** (`ui/toast.tsx`, genuinely modern) and it's used on
  exactly one page. No `Button`/`Card`/`Input`/`Select`/`Dialog`/`Spinner`/`Skeleton`/
  `EmptyState`.
- The 7 platform "Connect" buttons are the same markup copy-pasted 7×.

### 2.3 States & feedback
- No skeletons anywhere; three unrelated loading treatments (lucide spinner, plain
  "Loading…" text, a hand-rolled CSS spinner). Inconsistent success feedback (create-post
  shows a raw job id; settings picks green/red by `message.includes("success")` string match;
  most actions have no success state). The toast exists but is used only in reviews.

### 2.4 Accessibility
- 5 native `alert()`/`confirm()` (connection-actions, linkedin-dialog); the TikTok
  "Switch Account" flow is a `confirm()`→`window.open()`→`setTimeout`→`alert()` chain.
- The only modal (linkedin-setup-dialog) has no `role="dialog"`, `aria-modal`, focus trap,
  or Esc/backdrop close.
- Gradient-clip transparent headings on 5 pages (contrast/robustness risk).
- Autocomplete dropdown is not a real combobox (no listbox/aria-activedescendant).
- Leftover `console.log` debug noise in connection-actions and linkedin-dialog.

### 2.5 Dark mode
- Declared via `prefers-color-scheme` in `globals.css` but **zero `dark:` classes exist**;
  every page hardcodes `bg-white`/`text-gray-*`. On a dark-mode OS the result is broken. The
  feature is effectively dead and must be either implemented or removed.

### 2.6 Per-area (condensed)
- **create-post-form** (core flow, weakest UX): no upload progress bar for large video
  uploads, no media preview, success = raw job id, error = easy-to-miss 11px red text, does
  not use the toast.
- **media-library**: a read-only receipt list (filename·mime·size·date) — no thumbnails,
  no delete/reuse actions.
- **connections/connection-actions**: the worst a11y offender (confirm/alert/reload/console).
- **reviews module**: the strongest, most modern area — the template to generalize from.
- **settings**: best-structured page but a redundant second "Back to dashboard" link and
  fragile string-match feedback.
- **auth (login/register)**: solid and accessible; needs visual alignment + show-password.
- **google-business-location-form**: developer-facing (paste a raw resource string).
- **privacy/terms**: a 4th dialect; fine content, just needs visual alignment.

---

## 3. Design direction (decisions, with rationale)

These are opinionated defaults chosen to move fast; §8 lists where owner taste could redirect.

1. **Aesthetic: restrained modern SaaS.** Neutral surfaces, generous whitespace, strong
   typography, subtle depth (soft border + small shadow, not `shadow-2xl`), medium radius.
   **One confident accent** (brand indigo/blue) instead of blue+teal+green+purple. Gradients
   survive only as a subtle brand mark (logo, maybe one auth hero) — never on every button and
   heading. Reference points: Linear/Vercel restraint + Buffer/Later product shapes.
2. **Keep Geist** (already a modern typeface) but add a real type scale and use
   `text-foreground`/`text-muted-foreground` tokens instead of ad-hoc `text-gray-*`.
3. **Token-driven theming with real light + dark.** Define semantic CSS variables
   (`--background`, `--surface`, `--border`, `--primary`, `--muted`, `--muted-foreground`,
   `--success`, `--warning`, `--danger`, `--ring`, radius + shadow scales) in `globals.css`,
   exposed to Tailwind v4 via `@theme`. Dark mode flips the variables (class-based
   `.dark` + an optional system default) so components don't need `dark:` everywhere. This
   makes the half-dead dark mode real at near-zero per-component cost.
4. **Accessibility is a requirement, not a polish item.** WCAG AA contrast, visible focus
   rings, real dialog semantics + focus trap, combobox ARIA, keyboard nav, no native
   `alert()`/`confirm()`.
5. **Mobile-first, responsive.** Every view usable at 375px; the shell collapses to a top bar
   + drawer on mobile, sidebar on desktop.
6. **Market relevance now vs. later.** Now: unified composer with per-platform preview
   affordances, a dashboard, a visible activity/results view, connection health at a glance.
   Designed-for-later (shell accommodates, not built now): a scheduling calendar/queue and
   analytics — called out so the IA doesn't have to be redone when they arrive.

---

## 4. Design system spec (Phase A output)

- **Utilities:** a `cn()` class-merge helper. Allow two tiny, standard deps — `clsx` +
  `tailwind-merge` — or hand-roll `cn` if we want zero deps (decide in A; lean toward the two
  utils, ~6KB, industry standard). No other new runtime deps without justification.
- **Tokens** (`globals.css` + `@theme`): color roles, type scale, radius scale, shadow scale,
  spacing conventions, z-index scale, light + dark values.
- **Primitives** (`components/ui/`): `Button` (variants: primary/secondary/outline/ghost/
  destructive; sizes; loading state), `Card` (+ header/content/footer), `Input`, `Textarea`,
  `Select`, `Label`, `Badge`/status pill, `Dialog`/`Modal` (accessible: focus trap, Esc,
  backdrop, `aria-modal`), `Spinner`, `Skeleton`, `EmptyState`, `Alert`/callout. Adopt the
  existing `Toast` app-wide (promote `ToastProvider` into the shell).
- **A style-guide preview** route (dev-facing, e.g. `/design` gated or removed before final,
  or a Storybook-less `*.md`/page) so the look can be seen and tuned before mass migration.

---

## 5. Information architecture & navigation (Phase B)

- **App shell** in `layout.tsx` (or an authenticated layout group): persistent left sidebar on
  desktop (Dashboard, Create, Activity, Media, Reviews, Settings) + top bar with account menu
  and sign-out; on mobile a top bar + slide-over drawer. `ToastProvider` lives here so all
  pages get toasts. Public routes (login/register/privacy/terms) use a minimal shell.
- **Dashboard (`/`)**: replace the launcher with an overview — recent posts and their
  per-platform status, connection health (which of the 6 platforms are connected/expiring),
  quick actions (Create / Connect), and empty-state onboarding for new users.
- **Activity/results view**: a list of the user's `PostJob`s with per-platform
  `PostJobResult` status (success/failed + sanitized error), and a detail view. **Requires a
  small additive endpoint** `GET /api/posts` (list the current user's jobs) — server logic is
  otherwise untouched. This finally surfaces the app's core output.
- **Fixes:** `/connections` becomes a real `redirect('/settings')`; `error-state`'s link
  repoints to `/settings`; `/media` gets first-class nav.

---

## 6. Phase plan

Each phase ends in one PR (not merged without owner approval), with an Opus adversarial
review of the diff first. Behavior-preservation is verified every phase.

- **Phase A — Design foundation (Opus).** Tokens + `cn` + the primitive library + a preview.
  No page behavior changes; primitives proven on the preview. This is the contract the rest
  of the program builds on (like Phase 2 of the remediation program).
- **Phase B — Shell, dashboard, activity (Opus).** App shell + responsive nav in the layout;
  new dashboard; activity/results view + the additive `GET /api/posts` endpoint. First big
  visible slice — a natural checkpoint for owner sign-off on the aesthetic.
- **Phase C — Core flow migration (Sonnet, parallel worktrees by area).** create-post
  (upload progress + media preview + toast success/failure surfacing the real results), media
  library (thumbnails + reuse/delete), settings, connections (accessible switch-account dialog
  replacing confirm/alert; de-duplicate the 7 connect buttons), auth pages. Adopt toast
  app-wide.
- **Phase D — Alignment, dark mode, a11y (Sonnet + Opus review).** Reviews + privacy/terms
  aligned to the system; finalize dark mode; accessibility pass (dialog semantics, combobox
  ARIA, focus rings, contrast, keyboard); strip console.logs; kill dead `/connections`.
- **Phase E — Verification.** Visual QA at 375/768/1280 (light + dark) via preview/prod
  screenshots, a11y checks, drive the key flows, full gate (tsc 0, eslint 0 errors — blocking,
  build 0, vitest green), and a final whole-branch review.

Delegation: Fable orchestrates/integrates; Opus for foundation + shell/dashboard design and
per-phase adversarial review; Sonnet for bulk migration onto the established primitives.
Isolation: parallel worktrees for disjoint files; sequential for shared files; orchestrator
integrates.

---

## 7. Hard constraints

- **Preserve all behavior.** Same API endpoints/payloads, auth gates, OAuth flows, Inngest
  posting, rate limiter, grapheme truncation, settings validation. UI-only, except the single
  additive `GET /api/posts` list endpoint for the activity view.
- **Keep the gates green**, including the now-**blocking** eslint (0 errors), tsc 0, vitest,
  `next build` 0. New primitives are typed (no `any`) and lint-clean.
- **Don't regress the remediation work** — do not reintroduce token logging, weaken the DTOs,
  or touch server platform/job logic.
- **Dependencies:** at most `clsx` + `tailwind-merge` (tiny, standard). Anything else needs a
  written justification in its PR. No component-framework lock-in.
- **Accessibility:** WCAG AA. **Responsive:** usable at 375px.

---

## 8. Where owner taste could redirect (non-blocking; sensible defaults chosen)

1. **Accent color / brand** — default is a single confident indigo/blue; the owner may want a
   specific brand color. Easy to retune (it's one token).
2. **Sidebar vs. top-nav** — default is desktop sidebar + mobile drawer.
3. **How much gradient to keep** — default: minimal, brand-mark only.
4. **Dark mode default** — default: follow system, with a manual toggle in the account menu.
5. **Scope of the activity view** — default: list + per-platform status + detail; a full
   analytics dashboard is out of scope for this overhaul.

Phase B produces the first fully-styled slice (shell + dashboard); that is the ideal moment to
confirm direction before Phase C mass-migration.

---

## 9. Success criteria (when the goal is achieved)

- One coherent, modern design system (tokens + primitives) replacing the 3 dialects and
  ~12/8 button/card variants; used across every page.
- A persistent, responsive app shell; no more "Back to dashboard" island-hopping.
- A real dashboard and a visible post-activity/results view (the core output is no longer
  hidden).
- All `alert()`/`confirm()` replaced; accessible dialogs; WCAG AA; keyboard-navigable;
  console.logs stripped; dead `/connections` removed.
- Working light + dark mode.
- All gates green; behavior demonstrably unchanged; verified visually at mobile/tablet/desktop.
- PR(s) open and reviewed, awaiting owner merge.
