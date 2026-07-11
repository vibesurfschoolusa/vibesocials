# UX Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every bug and ship every improvement from the 2026-07-10 UX/UI review of Vibe Socials (branch `fix/ux-review-findings`, based on `feat/roadmap` @ d27757e).

**Architecture:** All work is inside `app/` (Next.js 16 App Router + TypeScript + Tailwind v4 tokens + Prisma + Inngest). No schema/migration changes anywhere — per-post platform targeting rides the existing `PostJob.publishMetadata` JSON column. UI changes follow the existing design system (`src/components/ui/*`, semantic tokens from `globals.css`).

**Tech Stack:** Next.js 16, React 19, next-auth v4 (JWT), Prisma, Vitest (unit; `src/**/*.test.ts` only — no `.tsx` component tests exist and none should be added), Playwright (e2e in `app/e2e/`), `@vercel/blob/client`.

## Global Constraints

- **DANGER — production credentials:** `app/.env.local` points at the PRODUCTION database/blob store. NEVER run `npm run dev`, `next dev`, `npm run start`, `prisma migrate`, `prisma db …`, `node` scripts that import `src/lib/db.ts`, or anything that opens a DB connection. Allowed commands: `npx vitest run <paths>`, `npm test`, `npm run lint`, `npm run build` (build is safe: Prisma connects lazily and no page queries at build time). Do not run `npx playwright test` (the controller runs it once at the end).
- Never modify: `app/.env.local`, `app/prisma/schema.prisma`, `app/prisma/migrations/**`.
- Working directory for all commands: `C:/Users/Klaus/Documents/Github_apps/vibesocials/app` (Windows; bash with forward slashes).
- UI copy is sentence case ("Publish post", not "Publish Post"). Toasts/helpers are short sentences.
- SEC-1 discipline: DTOs from API routes carry display fields only — never tokens, secrets, raw metadata JSON, or `userId`.
- Keep the Playwright public-route smoke expectations intact: `/login` h1 "Log in", `/register` h1 "Create an account", labelled "Email"/"Password" controls. When a task changes copy referenced by `app/e2e/core-flows.spec.ts` (it is skipped but must stay eye-checkable), update the spec in the same task — the task text says exactly what to change.
- Every task: run the named vitest files, then the full `npm test` (354 baseline tests must stay green plus your new ones), then commit. Run `npm run lint` before the commit and fix new errors your change introduced (baseline has 0 errors).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Toast fixes — mobile clipping, pause-on-hover, longer error timeout

**Files:**
- Modify: `src/components/ui/toast.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: unchanged public API (`useToast().success/error/info`). Later tasks rely on error toasts staying visible 8s.

- [ ] **Step 1: Change duration to per-variant and make dismissal re-armable**

In `toast.tsx`, replace the single constant (line 31) with:

```ts
const AUTO_DISMISS_MS: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  error: 8000, // errors carry actionable info — give them longer
};
```

In `ToastProvider`, extract the arm/disarm logic so hover can reuse it. Replace the body of `push` and add two callbacks:

```ts
const armDismiss = useCallback(
  (id: number, variant: ToastVariant) => {
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS[variant]);
    timers.current.set(id, timer);
  },
  [dismiss]
);

const pauseDismiss = useCallback((id: number) => {
  const timer = timers.current.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.current.delete(id);
  }
}, []);

const push = useCallback(
  (message: string, variant: ToastVariant) => {
    idRef.current += 1;
    const id = idRef.current;
    setToasts((prev) => [...prev, { id, message, variant }]);
    armDismiss(id, variant);
  },
  [armDismiss]
);
```

Pass `onPause={pauseDismiss}` and `onResume={armDismiss}` down to `Toaster`; on each toast div add `onMouseEnter={() => onPause(toast.id)}` and `onMouseLeave={() => onResume(toast.id, toast.variant)}` (resume re-arms the full variant duration — acceptable simplification).

- [ ] **Step 2: Fix the mobile clipping and error role**

The container (line ~128) currently `fixed bottom-4 right-4 … w-full max-w-sm` overflows the left edge below ~400px. Change its className to:

```
pointer-events-none fixed bottom-4 left-4 right-4 sm:left-auto sm:w-full sm:max-w-sm z-[60] flex flex-col gap-2
```

On the toast item div, change `role="status"` to `role={toast.variant === "error" ? "alert" : "status"}`.

- [ ] **Step 3: Verify and commit**

Run: `npm test` → 354 passed. Run `npm run lint` → no new errors.

```bash
git add src/components/ui/toast.tsx
git commit -m "fix(toast): mobile inset, pause-on-hover, 8s error timeout, role=alert for errors"
```

---

### Task 2: Settings — OAuth result banner, footer-preview drift, reconnect affordance, disconnect copy

**Files:**
- Create: `src/lib/oauthResult.ts`
- Create: `src/lib/oauthResult.test.ts`
- Modify: `src/app/settings/page.tsx`
- Modify: `src/components/settings-form.tsx`
- Modify: `src/components/connection-actions.tsx`
- Modify: `src/components/dashboard/connection-health.tsx`

**Interfaces:**
- Produces: `describeOAuthResult(params: { error: string | null; success: string | null }): { variant: "success" | "danger"; message: string } | null` in `src/lib/oauthResult.ts`.

**Background:** Every OAuth callback (`src/app/api/auth/*/callback/route.ts`) redirects to `/settings?error=<code>` or `/settings?success=<platform>_connected`, and nothing reads those params today. Codes follow `<platform>_<reason>` where `<platform>` may itself contain underscores (`google_business_profile_oauth_denied`). Enumerate actual codes with `grep -rho "settings?[a-z_=&]*" src/app/api/auth/*/callback/route.ts | sort -u` and make the mapper cover every one you find.

- [ ] **Step 1: Write the failing test** (`src/lib/oauthResult.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { describeOAuthResult } from "./oauthResult";

describe("describeOAuthResult", () => {
  it("returns null when neither param is present", () => {
    expect(describeOAuthResult({ error: null, success: null })).toBeNull();
  });

  it("maps a success code to a success message with the platform label", () => {
    expect(describeOAuthResult({ error: null, success: "youtube_connected" })).toEqual({
      variant: "success",
      message: "YouTube connected.",
    });
  });

  it("maps a denied error to a 'you cancelled' message", () => {
    const result = describeOAuthResult({ error: "tiktok_oauth_denied", success: null });
    expect(result?.variant).toBe("danger");
    expect(result?.message).toContain("TikTok");
    expect(result?.message).toContain("cancelled");
  });

  it("handles platforms whose key contains underscores", () => {
    const result = describeOAuthResult({
      error: "google_business_profile_oauth_denied",
      success: null,
    });
    expect(result?.message).toContain("Google Business Profile");
  });

  it("falls back to a generic failure for unknown codes", () => {
    const result = describeOAuthResult({ error: "bogus_code", success: null });
    expect(result?.variant).toBe("danger");
    expect(result?.message).toContain("couldn't be connected");
  });

  it("error wins when both params are present", () => {
    const result = describeOAuthResult({
      error: "x_oauth_denied",
      success: "x_connected",
    });
    expect(result?.variant).toBe("danger");
  });
});
```

Run: `npx vitest run src/lib/oauthResult.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement `src/lib/oauthResult.ts`**

```ts
import type { Platform } from "@prisma/client";
import { PLATFORM_LABELS } from "@/lib/platforms";

/** Longest-prefix match so google_business_profile_* resolves correctly. */
function platformFromCode(code: string): string {
  const match = (Object.keys(PLATFORM_LABELS) as Platform[])
    .filter((key) => code === key || code.startsWith(`${key}_`))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PLATFORM_LABELS[match] : "The account";
}

/**
 * Human-readable outcome for the ?error= / ?success= params every OAuth
 * callback appends to /settings. Returns null when neither is present.
 * Error wins when both are present.
 */
export function describeOAuthResult(params: {
  error: string | null;
  success: string | null;
}): { variant: "success" | "danger"; message: string } | null {
  const { error, success } = params;

  if (error) {
    const label = platformFromCode(error);
    if (error.includes("denied")) {
      return {
        variant: "danger",
        message: `You cancelled the ${label} authorization — nothing was connected. Click Connect to try again.`,
      };
    }
    if (error.includes("missing_params") || error.includes("invalid_state")) {
      return {
        variant: "danger",
        message: `The ${label} sign-in couldn't be completed securely. Please try connecting again.`,
      };
    }
    return {
      variant: "danger",
      message: `${label} couldn't be connected. Please try again.`,
    };
  }

  if (success) {
    return { variant: "success", message: `${platformFromCode(success)} connected.` };
  }

  return null;
}
```

Run: `npx vitest run src/lib/oauthResult.test.ts` → PASS. If the grep in Background surfaced codes that don't fit these three buckets (denied / missing_params+invalid_state / everything-else-generic), extend the mapper and add a test per new bucket.

- [ ] **Step 3: Render the banner on the settings page**

`src/app/settings/page.tsx` is a server component. Next 16 passes `searchParams` as a Promise. Change the signature and render an `Alert` above the header:

```tsx
import { Alert } from "@/components/ui/alert";
import { describeOAuthResult } from "@/lib/oauthResult";
import Link from "next/link";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/settings")}`);
  }

  const params = await searchParams;
  const oauthResult = describeOAuthResult({
    error: params.error ?? null,
    success: params.success ?? null,
  });
  // …existing settings/connections queries unchanged…
```

Directly inside the top-level container div, before the `<header>`:

```tsx
{oauthResult ? (
  <Alert variant={oauthResult.variant} className="mb-6">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p>{oauthResult.message}</p>
      <Link
        href="/settings"
        className="text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        Dismiss
      </Link>
    </div>
  </Alert>
) : null}
```

(The Dismiss link clears the query params by re-navigating to bare `/settings` — no client component needed.)

- [ ] **Step 4: Fix the footer-preview drift in `settings-form.tsx`**

Delete the local `previewCaption()` implementation (lines ~61-78) and replace with the real caption builder so preview == reality:

```ts
import { buildCaptionWithFooter } from "@/lib/captionFooter";

const previewCaption = () =>
  buildCaptionWithFooter("Check out this amazing content!", {
    companyWebsite,
    defaultHashtags,
  });
```

Change the hashtags helper text (line ~105-107) from "Added on a new line after your website." to: `Added after your website, separated by a blank line.`

- [ ] **Step 5: Make Reconnect a real button and warn about scheduled posts on disconnect**

In `src/components/connection-actions.tsx` (lines ~109-117), replace the badge-in-anchor with a destructive button-styled anchor (keeps `/api/auth/*/start` as a plain `<a>` — it is a redirect handler, not a Next route):

```tsx
import { buttonVariants } from "@/components/ui/button";
// …
{needsReconnect ? (
  <a href={authUrl} className={buttonVariants({ variant: "destructive", size: "sm" })}>
    Reconnect
  </a>
) : (
  <Badge variant="success">Connected</Badge>
)}
```

In the same file, change the disconnect `ConfirmDialog` description (line ~139) to:
`"Future posts — including scheduled ones — will skip this platform. You can reconnect at any time."`

In `src/components/dashboard/connection-health.tsx` (lines ~78-87), make the same replacement (keep the `AlertTriangle` icon inside the anchor):

```tsx
<a
  href={`/api/auth/${connection.platform}/start`}
  className={buttonVariants({ variant: "destructive", size: "sm", className: "h-7 gap-1 px-2 text-xs" })}
>
  <AlertTriangle aria-hidden className="h-3.5 w-3.5" />
  Reconnect
</a>
```

Remove the now-unused `Badge` import in `connection-health.tsx` only if nothing else in the file uses it (the success "Connected" badge still does — keep it).

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run src/lib/oauthResult.test.ts` then `npm test` (all green), `npm run lint`.

```bash
git add src/lib/oauthResult.ts src/lib/oauthResult.test.ts src/app/settings/page.tsx src/components/settings-form.tsx src/components/connection-actions.tsx src/components/dashboard/connection-health.tsx
git commit -m "fix(settings): surface OAuth connect outcomes, fix footer preview drift, real Reconnect buttons, scheduled-post disconnect warning"
```

---

### Task 3: Auth flows — password validation, auto-sign-in, callbackUrl, consistent gating

**Files:**
- Modify: `src/app/api/auth/register/route.ts`
- Create: `src/app/api/auth/register/route.test.ts`
- Modify: `src/app/register/page.tsx`
- Modify: `src/app/login/page.tsx`
- Modify: `src/app/queue/page.tsx`, `src/app/activity/page.tsx`, `src/app/media/page.tsx`, `src/app/posts/new/page.tsx`
- Modify: `app/e2e/core-flows.spec.ts` (register flow only)

**Interfaces:**
- Produces: `/login?callbackUrl=<path>&registered=1` param contract consumed by Task 4 (reviews gate uses the same pattern).

- [ ] **Step 1: Write failing route tests** (`src/app/api/auth/register/route.test.ts`)

Mirror the `vi.mock` structure of `src/app/api/settings/route.test.ts` (mock `@/lib/db` with a `prisma.user.findUnique/create` stub; this route has no auth dependency). Test cases — each posts JSON to the handler and asserts status + `error` string:

```ts
// 1. missing email/password            -> 400 "Email and password are required."
// 2. invalid email ("not-an-email")    -> 400 "Enter a valid email address."
// 3. short password ("short")          -> 400 "Password must be at least 8 characters."
// 4. duplicate email (findUnique returns a row) -> 400 "A user with that email already exists."
// 5. happy path -> 201, body has id/email/name, create called with a bcrypt hash (assert passwordHash !== plain password)
```

Run: `npx vitest run src/app/api/auth/register/route.test.ts` → cases 2 and 3 FAIL (no validation yet).

- [ ] **Step 2: Add validation to the register route**

After the existing `if (!email || !password)` guard in `src/app/api/auth/register/route.ts`, insert:

```ts
if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email)) {
  return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
}
if (typeof password !== "string" || password.length < 8) {
  return NextResponse.json(
    { error: "Password must be at least 8 characters." },
    { status: 400 },
  );
}
```

Run the test file → PASS.

- [ ] **Step 3: Register page — requirements copy, optional Name, auto-sign-in**

In `src/app/register/page.tsx`:
- Name label → `Name <span className="font-normal text-muted-foreground">(optional)</span>` (matches the composer's Location convention).
- Under the password input add: `<p className="text-xs text-muted-foreground">At least 8 characters.</p>`
- Add `minLength={8}` to the password input.
- The page needs `useSearchParams` for callbackUrl pass-through, which requires a Suspense boundary: rename the current component to `RegisterPageInner` and export `default function RegisterPage()` returning `<Suspense fallback={null}><RegisterPageInner /></Suspense>` (same pattern as `CreatePostForm` in `src/components/create-post-form.tsx:1021`).
- Sanitize the param once: `const raw = searchParams.get("callbackUrl"); const callbackUrl = raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";`
- On successful registration (201), sign in immediately instead of bouncing to /login cold:

```ts
import { signIn } from "next-auth/react";
// … after the !response.ok guard:
const result = await signIn("credentials", { redirect: false, email, password });
if (result?.ok) {
  router.push(callbackUrl);
  return;
}
// Extremely unlikely (account was just created) — fall back to a friendly login handoff.
router.push(`/login?registered=1&callbackUrl=${encodeURIComponent(callbackUrl)}`);
```

- The "Already have an account? Log in" link keeps `href="/login"`.

- [ ] **Step 4: Login page — callbackUrl, registered banner, forgot-password hint, error handling**

In `src/app/login/page.tsx`:
- Same Suspense/`useSearchParams` restructure as Step 3 (inner component + Suspense wrapper).
- Same `callbackUrl` sanitation. `const registered = searchParams.get("registered") === "1";`
- Replace the post-signIn logic:

```ts
const result = await signIn("credentials", { redirect: false, email, password });
if (result?.ok) {
  router.push(callbackUrl);
  return;
}
setError("Invalid email or password.");
setLoading(false);
```

- Above the form, when `registered` is true render: `<Alert variant="success" className="mb-4">Account created — sign in below.</Alert>` (only reachable via the Step-3 fallback path).
- After the "Need an account?" paragraph add:

```tsx
<p className="mt-2 text-center text-xs text-muted-foreground">
  Forgot your password? Reset isn&apos;t available yet — contact the site owner.
</p>
```

- The "Create one" link becomes `href={callbackUrl === "/" ? "/register" : `/register?callbackUrl=${encodeURIComponent(callbackUrl)}`}`.

- [ ] **Step 5: Unify protected-page gating with callbackUrl**

- `src/app/queue/page.tsx` and `src/app/activity/page.tsx`: change `redirect("/login")` to `` redirect(`/login?callbackUrl=${encodeURIComponent("/queue")}`) `` (respectively `"/activity"`).
- `src/app/media/page.tsx`: delete the entire signed-out `EmptyState` branch (lines 12-39) and replace with `` redirect(`/login?callbackUrl=${encodeURIComponent("/media")}`) `` (import `redirect` from `next/navigation`; drop now-unused imports `Link`, `Lock`, `buttonVariants`, `EmptyState`).
- `src/app/posts/new/page.tsx`: same — delete the signed-out card branch (lines 12-36), `` redirect(`/login?callbackUrl=${encodeURIComponent("/posts/new")}`) ``, drop unused imports.
- Do NOT touch `src/app/settings/page.tsx` (Task 2 owns it) or `src/app/reviews/page.tsx` (Task 4 owns it).

- [ ] **Step 6: Sync the e2e register scaffold**

In `app/e2e/core-flows.spec.ts`, the "register via the UI, then log in" test (lines ~106-129) currently expects register → /login → manual login. Update: after clicking "Create account", expect `page.getByRole("heading", { level: 1, name: "Welcome back" })` (auto-signed-in dashboard); then `await context.clearCookies();` then `page.goto("/login")` and keep the existing manual-login assertions. Update the test's comment to describe the new flow.

- [ ] **Step 7: Verify and commit**

Run: `npx vitest run src/app/api/auth/register/route.test.ts`, then `npm test`, `npm run lint`.

```bash
git add src/app/api/auth/register src/app/register/page.tsx src/app/login/page.tsx src/app/queue/page.tsx src/app/activity/page.tsx src/app/media/page.tsx src/app/posts/new/page.tsx e2e/core-flows.spec.ts
git commit -m "feat(auth): password validation, register auto-sign-in, callbackUrl-preserving gates, forgot-password hint"
```

---

### Task 4: Reviews — auth gate, replied tab, public-reply confirm, design alignment

**Files:**
- Create: `src/app/reviews/reviews-view.tsx` (the current client content moves here)
- Modify: `src/app/reviews/page.tsx` (becomes a server gate)
- Modify: `src/components/reviews/reply-form.tsx`, `src/components/reviews/review-card.tsx`, `src/components/reviews/error-state.tsx` (only if casing appears there)

**Interfaces:**
- Consumes: `/login?callbackUrl=…` contract from Task 3.

- [ ] **Step 1: Server auth gate**

Move everything except the default export from `src/app/reviews/page.tsx` into a new `"use client"` file `src/app/reviews/reviews-view.tsx` exporting `export function ReviewsView()` (rename `ReviewsPageContent` → `ReviewsView`, keep all logic). Replace `page.tsx` with:

```tsx
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { ReviewsView } from "./reviews-view";

// Server-side auth gate (matches queue/activity): signed-out users are
// redirected before the client view ever fetches — no more raw
// "Unauthorized" error page.
export default async function ReviewsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/reviews")}`);
  }
  return <ReviewsView />;
}
```

- [ ] **Step 2: Tabs — needs reply / replied**

In `reviews-view.tsx` add `const [tab, setTab] = useState<"needs_reply" | "replied">("needs_reply");` and `const repliedReviews = reviews.filter((r) => r.reviewReply);`. Below the summary card render a segmented control copying the composer's publish-mode pattern (`create-post-form.tsx:922`: `role="group"` + `aria-pressed` buttons inside a bordered inline-flex):

- Group `aria-label="Review filter"`, buttons labelled `` `Needs reply (${needsReplyReviews.length})` `` and `` `Replied (${repliedReviews.length})` ``.
- The list renders `needsReplyReviews` or `repliedReviews` by tab. For the replied tab pass `needsReply={false}` to `ReviewCard` (it already renders the existing reply block and hides the reply form).
- The "All caught up!" card renders only on the needs-reply tab when it is empty. Empty replied tab renders `<EmptyState icon={<MessageSquare />} title="No replies yet" description="Reviews you've replied to will appear here." />`.

- [ ] **Step 3: Confirm before posting a public reply**

In `reviews-view.tsx`:
- Add `const [confirmTarget, setConfirmTarget] = useState<GoogleReview | null>(null);`
- `requestReply` now validates then `setConfirmTarget(review)` instead of calling `performReply`.
- Refactor `performReply` so the fetch-failure path THROWS after toasting (the `ConfirmDialog` contract keeps the dialog open on throw — see `src/components/ui/dialog.tsx:319`), and the success path keeps its current state updates.
- Render once at the bottom:

```tsx
<ConfirmDialog
  open={confirmTarget !== null}
  onOpenChange={(open) => { if (!open) setConfirmTarget(null); }}
  title="Post this reply publicly?"
  description="It will appear on your Google Business Profile listing for everyone to see."
  confirmText="Post reply"
  onConfirm={async () => { if (confirmTarget) await performReply(confirmTarget); }}
/>
```

(Import `ConfirmDialog` from `@/components/ui/dialog`.) The inline `isSubmitting` spinner state stays as-is.

- [ ] **Step 4: Connect-GBP CTA + design alignment**

- The "Select a Location" empty state: title → "Select a location"; when `locations.length === 0` change title to "Connect Google Business Profile", description to "Reviews come from your Google Business Profile listing. Connect it in Settings to see and reply to reviews here.", and add `action={<Link href="/settings" className={buttonVariants({ variant: "primary" })}>Go to connections</Link>}` (imports: `Link` from `next/link`, `buttonVariants`).
- Header: `text-3xl` → `text-2xl font-bold tracking-tight`; subtitle → `mt-1 text-sm text-muted-foreground`.
- Replace both full-page `Spinner` blocks with skeletons (`aria-hidden` wrapper + three `<Skeleton className="h-40 w-full" />` stacked with `space-y-4`), importing `Skeleton`.
- Sentence-case sweep in reviews files: "Reviews Needing Reply" → "Reviews needing reply"; "Error Loading Reviews" → "Couldn't load reviews"; "All Caught Up!" → "All caught up!"; "Needs Reply" badge → "Needs reply"; "Your Reply" → "Your reply"; "Reply to Review" → "Reply to review"; "Post Reply" → "Post reply"; "Draft AI Response" → "Draft AI response"; "Generating..." → "Generating…".
- Swap the `Star` icon on both "Draft AI response" buttons for `Sparkles` (matches the composer's AI affordance; `star-rating.tsx` keeps `Star`).

- [ ] **Step 5: Verify and commit**

Run: `npm test`, `npm run lint`.

```bash
git add src/app/reviews src/components/reviews
git commit -m "feat(reviews): auth gate, replied tab, confirm public replies, align with design system"
```

---

### Task 5: Media — client-blob upload with progress, upload validation, retention visibility

**Files:**
- Create: `src/lib/blobKey.ts`
- Modify: `src/app/api/upload/route.ts`
- Modify: `src/app/api/media/route.ts`
- Create: `src/app/api/media/route.test.ts`
- Modify: `src/lib/mediaDto.ts` + `src/lib/mediaDto.test.ts` (create test file if absent)
- Modify: `src/components/media-library.tsx`

**Interfaces:**
- Produces: `generateBlobKey(file: File): string` in `src/lib/blobKey.ts` (Task 6 switches the composer to it). `POST /api/media` now takes JSON `{ blobUrl, filename, mimeType, sizeBytes, baseCaption? }`. `MediaItemDto` gains `lastUsedAt: string | null`. `daysUntilRemoval(lastUsedAt: string | null, retentionDays: number, now: Date): number | null` in `src/lib/mediaDto.ts`.

- [ ] **Step 1: Extract the blob-key helper**

Create `src/lib/blobKey.ts` with the exact implementation currently at `src/components/create-post-form.tsx:96-100`:

```ts
/** Collision-safe, filesystem-safe Vercel Blob key for an upload. */
export function generateBlobKey(file: File): string {
  const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${random}-${safeName}`;
}
```

Do NOT touch create-post-form.tsx (Task 6 owns it and will swap its local copy for this import).

- [ ] **Step 2: Add a size cap to the upload token route**

In `src/app/api/upload/route.ts`, inside the `onBeforeGenerateToken` return object add:

```ts
// Blob store cap for a single upload. Matches the largest media any
// connected platform accepts in practice; the platforms themselves
// enforce their own stricter limits at publish time.
maximumSizeInBytes: 512 * 1024 * 1024,
```

- [ ] **Step 3: Failing tests for the reworked `POST /api/media`** (`src/app/api/media/route.test.ts`)

Mirror the mock structure of `src/app/api/media/[id]/route.test.ts` (mock `@/lib/auth` getCurrentUser and `@/lib/db` prisma). Cases:

```ts
// 1. unauthenticated                          -> 401
// 2. multipart content type                   -> 400 error mentions "application/json"
// 3. missing blobUrl                          -> 400 "blobUrl is required"
// 4. mimeType "application/pdf"               -> 400 "Only image or video files can be added to the library."
// 5. sizeBytes 600*1024*1024 (over cap)       -> 400 "File is too large (max 512 MB)."
// 6. happy path (image/png, 1234 bytes)       -> 201, prisma.mediaItem.create called with
//      { userId, storageLocation: blobUrl, originalFilename: filename, mimeType, sizeBytes, baseCaption }
// 7. GET returns items including lastUsedAt as ISO string or null (extend existing select assertion)
```

Run → FAIL.

- [ ] **Step 4: Rework `POST /api/media` to register an already-uploaded blob**

Replace the multipart body handling in `src/app/api/media/route.ts` (keep GET; POST changes):

```ts
const contentType = request.headers.get("content-type") || "";
if (!contentType.includes("application/json")) {
  return NextResponse.json(
    { error: "Content-Type must be application/json" },
    { status: 400 },
  );
}

let body: {
  blobUrl?: unknown; filename?: unknown; mimeType?: unknown;
  sizeBytes?: unknown; baseCaption?: unknown;
};
try {
  body = await request.json();
} catch {
  return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
}

const blobUrl = typeof body.blobUrl === "string" ? body.blobUrl.trim() : "";
if (!blobUrl) {
  return NextResponse.json({ error: "blobUrl is required" }, { status: 400 });
}
const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/")) {
  return NextResponse.json(
    { error: "Only image or video files can be added to the library." },
    { status: 400 },
  );
}
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const sizeBytes = typeof body.sizeBytes === "number" && Number.isFinite(body.sizeBytes)
  ? body.sizeBytes
  : 0;
if (sizeBytes <= 0 || sizeBytes > MAX_MEDIA_BYTES) {
  return NextResponse.json(
    { error: "File is too large (max 512 MB)." },
    { status: 400 },
  );
}
const filename = typeof body.filename === "string" && body.filename.trim()
  ? body.filename.trim()
  : "upload";
const baseCaption = typeof body.baseCaption === "string" ? body.baseCaption.trim() : "";

const mediaItem = await prisma.mediaItem.create({
  data: {
    userId: user.id,
    storageLocation: blobUrl,
    originalFilename: filename,
    mimeType,
    sizeBytes,
    baseCaption,
  },
});
return NextResponse.json({ mediaItem }, { status: 201 });
```

Drop the `saveUploadedFile` and `perPlatformOverrides` handling (the form never sent overrides; verify with `grep -rn "perPlatformOverrides" src/components/media-library.tsx` → no hits). Remove now-unused imports. Add `lastUsedAt: true` to the GET `select`. Run the test file → PASS.

- [ ] **Step 5: DTO + retention countdown helper**

In `src/lib/mediaDto.ts`: add `lastUsedAt: string | null` to `MediaItemDto` and map it in `toMediaItemDto` (`item.lastUsedAt?.toISOString() ?? null`). Add:

```ts
/**
 * Days until the retention sweep may remove a POSTED item's blob, or null when
 * the item has never been used in a post (never-posted uploads are exempt —
 * see server/jobs/mediaRetention.ts). 0 means "eligible now".
 */
export function daysUntilRemoval(
  lastUsedAt: string | null,
  retentionDays: number,
  now: Date,
): number | null {
  if (!lastUsedAt) return null;
  const last = new Date(lastUsedAt).getTime();
  if (Number.isNaN(last)) return null;
  const msLeft = last + retentionDays * 24 * 60 * 60 * 1000 - now.getTime();
  return Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
}
```

Tests (create or extend `src/lib/mediaDto.test.ts`): null input → null; invalid date string → null; used 10 days ago with 30-day retention → 20; used 40 days ago → 0; used just now → 30.

- [ ] **Step 6: Media library — client upload + progress + retention copy**

In `src/components/media-library.tsx`:
- Add `import { upload } from "@vercel/blob/client";`, `import { generateBlobKey } from "@/lib/blobKey";`, `import { RETENTION_DAYS } from "@/server/jobs/mediaRetention";` (pure module — no prisma import, safe in client bundles), `import { daysUntilRemoval } from "@/lib/mediaDto";` and switch the local `MediaItemDto` interface to add `lastUsedAt: string | null`.
- Add `const [uploadProgress, setUploadProgress] = useState<number | null>(null);`
- Rework `handleSubmit`: client-side guard first (`if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) { toast.error("Only image or video files can be added to the library."); return; }`), then:

```ts
setUploading(true);
setUploadProgress(0);
try {
  const blob = await upload(generateBlobKey(file), file, {
    access: "public",
    handleUploadUrl: "/api/upload",
    onUploadProgress: (event) => setUploadProgress(event.percentage),
  });
  const response = await fetch("/api/media", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      blobUrl: blob.url,
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      baseCaption,
    }),
  });
  // …existing !response.ok toast + success handling unchanged…
} catch (err) {
  toast.error(err instanceof Error ? err.message : "Unexpected error while uploading media.");
} finally {
  setUploading(false);
  setUploadProgress(null);
}
```

- Below the file input, when `uploadProgress !== null`, render the same progress bar block as `create-post-form.tsx:798-818` (`role="progressbar"` with `aria-valuenow/min/max`, label "Uploading…", percentage).
- Card meta line: after the date, when `daysUntilRemoval(item.lastUsedAt, RETENTION_DAYS, new Date()) !== null` append `· auto-removes in {n} days` (render "auto-removes soon" when n === 0).
- Header `CardDescription` becomes: "Add a video or image once, then reuse it across posts. Items you've posted are removed automatically 30 days after their last use; never-posted uploads stay until you delete them."

- [ ] **Step 7: Verify and commit**

Run: `npx vitest run src/app/api/media/route.test.ts src/lib/mediaDto.test.ts`, `npm test`, `npm run lint`.

```bash
git add src/lib/blobKey.ts src/app/api/upload/route.ts src/app/api/media/route.ts src/app/api/media/route.test.ts src/lib/mediaDto.ts src/lib/mediaDto.test.ts src/components/media-library.tsx
git commit -m "fix(media): client-blob uploads with progress + validation, surface 30-day retention"
```

---

### Task 6: Composer UX — zero-connection gate, single connection source, TikTok enforcement, copy

**Files:**
- Modify: `src/components/create-post-form.tsx`
- Modify: `src/components/tiktok-post-settings.tsx`
- Modify: `app/e2e/core-flows.spec.ts` (submit-button name)

**Interfaces:**
- Consumes: `generateBlobKey` from `src/lib/blobKey.ts` (Task 5).
- Produces: `TikTokPostSettings` new props `commercialContentEnabled: boolean; onCommercialContentEnabledChange: (enabled: boolean) => void` (state lifted to the form). Submit button renamed "Publish post". Task 7 builds targeting on top of `connectedPlatforms` + this file's structure.

- [ ] **Step 1: One source of truth for connection state**

In `create-post-form.tsx`:
- Delete `checkTikTokConnection`, `checkYouTubeConnection`, the `useEffect` calling them (lines ~200-203, 295-316), and the two `useState` flags.
- Derive from the existing `useConnections()` call:

```ts
const { connections } = useConnections();
const connectionsResolved = connections !== null;
const hasTikTokConnection =
  connections?.some((c) => c.platform === "tiktok" && c.connected) ?? false;
const hasYouTubeConnection =
  connections?.some((c) => c.platform === "youtube" && c.connected) ?? false;
```

- Simplify `connectedPlatforms` to a single expression over `connections` (the tiktok/youtube special cases go away):

```ts
const connectedPlatforms = useMemo(
  () =>
    PLATFORM_ORDER.filter((platform) =>
      connections?.some((c) => c.platform === platform && c.connected),
    ),
  [connections],
);
```

(`TikTokPostSettings` still fetches `/api/tiktok/creator-info` itself — that is now the only creator-info call per composer load; its error state already covers an expired-token connection.)

- Replace the local `generateBlobKey` function with `import { generateBlobKey } from "@/lib/blobKey";`.

- [ ] **Step 2: Zero-connection empty state + disabled submit**

Directly under the success/error alerts at the top of the form, render when resolved-and-empty:

```tsx
{connectionsResolved && connectedPlatforms.length === 0 ? (
  <EmptyState
    icon={<PlugZap />}
    title="Connect a platform to start posting"
    description="Vibe Socials publishes to the platforms you've connected. Connect at least one in Settings, then come back here."
    action={
      <Link href="/settings" className={buttonVariants({ variant: "primary" })}>
        Go to connections
      </Link>
    }
  />
) : null}
```

(Imports: `EmptyState` from `@/components/ui/empty-state`, `PlugZap` from `lucide-react`.) Add `disabled={connectionsResolved && connectedPlatforms.length === 0}` to the submit `<Button>`. Also fix the error toast to prefer the API's actionable message: in the `!response.ok` branch of `handleUploadSubmit`, use `(data as { message?: string; error?: string } | null)?.message ?? (data as { error?: string } | null)?.error ?? "Failed to create post."`.

- [ ] **Step 3: Enforce the TikTok commercial-content rule**

In `tiktok-post-settings.tsx`: delete the internal `const [commercialContentEnabled, setCommercialContentEnabled] = useState(false)` and take the pair from props (add both to `TikTokPostSettingsProps`; `handleCommercialToggle` calls `onCommercialContentEnabledChange(enabled)` instead of the setter). Everything else unchanged.

In `create-post-form.tsx`:
- `const [tiktokCommercialEnabled, setTiktokCommercialEnabled] = useState(false);` — pass to the panel; reset it to `false` in the post-success reset block.
- In `handleUploadSubmit`, right after the caption guard:

```ts
const tiktokCommercialBlocked =
  hasTikTokConnection &&
  tiktokCommercialEnabled &&
  !tiktokMetadata.brandedContent &&
  !tiktokMetadata.brandOrganic;
if (tiktokCommercialBlocked) {
  setUploadError(
    'Select "Your brand" or "Branded content" (or turn off the promotional toggle) before posting to TikTok.',
  );
  return;
}
```

- [ ] **Step 4: Accessibility + copy in the TikTok panel**

In `tiktok-post-settings.tsx`:
- Privacy select: add `aria-describedby={privacyError ? "tiktok-privacy-error" : "tiktok-privacy-help"}`; give the error `<p>` `id="tiktok-privacy-error"` and the helper `<p>` `id="tiktok-privacy-help"`.
- Sentence-case the panel: "TikTok Post Settings" → "TikTok post settings"; "Privacy Level" → "Privacy level"; "Interaction Settings" → "Interaction settings"; "Allow Comments/Duet/Stitch" → "Allow comments/duets/stitches"; "Your Brand" → "Your brand"; "Branded Content" → "Branded content"; "TikTok Settings Error" → "Couldn't load TikTok settings".
- In `youtube-post-settings.tsx`… (not in Files — leave it; Task 10 sweeps it.)

- [ ] **Step 5: Composer copy + success-alert visibility + stale comment**

In `create-post-form.tsx`:
- Delete the stale comment block at lines ~448-451 ("TikTok privacy is only required … don't persist per-post TikTok/YouTube metadata …") and replace with: `// Deferred (schedule/draft) jobs persist tiktok/youtube metadata on the job (PostJob.publishMetadata) and replay it at publish — see server/jobs/posting.ts.`
- Auto-caption checkbox label → "Generate a caption when media is added".
- Button "Auto Caption" → "Caption from media"; "AI Enhance" → "Enhance caption".
- Submit label: immediate mode "Create post" → "Publish post" and its loading label "Creating post…" → "Publishing…" (schedule/draft labels unchanged).
- Success-alert scroll: `const successRef = useRef<HTMLDivElement>(null);` wrap the success `<Alert>` in `<div ref={successRef}>…</div>`, and add:

```ts
useEffect(() => {
  if (!showSuccess) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  successRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
}, [showSuccess]);
```

- [ ] **Step 6: Sync e2e + verify + commit**

In `app/e2e/core-flows.spec.ts` line ~155: `{ name: "Create post" }` → `{ name: "Publish post" }` (the compose flow's submit click only — the "Create post" H1 assertions stay).

Run: `npm test`, `npm run lint`.

```bash
git add src/components/create-post-form.tsx src/components/tiktok-post-settings.tsx e2e/core-flows.spec.ts
git commit -m "feat(composer): zero-connection gate, unified connection source, TikTok commercial enforcement, clearer copy"
```

---

### Task 7: Per-post platform targeting + publish-now confirmation

**Files:**
- Modify: `src/server/jobs/posting.ts` + `src/server/jobs/posting.test.ts` + `src/server/jobs/deferredDispatch.test.ts`
- Modify: `src/app/api/posts/route.ts` + `src/app/api/posts/route.test.ts`
- Modify: `src/components/create-post-form.tsx`
- Modify: `app/e2e/core-flows.spec.ts` (confirm-dialog click-through)

**Interfaces:**
- Consumes: Task 6's `connectedPlatforms` / `selected` composer structure.
- Produces: `POST /api/posts` accepts optional `platforms: Platform[]`; `PublishMetadataSnapshot` gains `targetPlatforms?: Platform[]`; `buildPublishMetadataSnapshot(tiktokMetadata?, youtubeMetadata?, targetPlatforms?)` (third positional param). Task 8 reads `publishMetadata.targetPlatforms` for the Queue display.

- [ ] **Step 0: Verify the fan-out invariant**

Run `grep -n "postJobResult\|results" src/server/jobs/inngest-functions.ts | head -30` and confirm `publishToAllPlatforms` derives its fan-out from the job's existing `PostJobResult` rows (created by `createPostJobOnly` / `prepareDeferredPostJobDispatch`), not by re-querying connections. If it re-queries connections anywhere, STOP and report BLOCKED with the line numbers — the design below assumes result rows define the fan-out.

- [ ] **Step 1: Failing tests for the server-side filter**

`src/server/jobs/posting.test.ts` — add cases following the file's existing mock conventions:

```ts
// createPostJobOnly (immediate):
// 1. targetPlatforms ["youtube"] with youtube+tiktok connected -> creates exactly one
//    PostJobResult (platform "youtube")
// 2. targetPlatforms ["x"] with only youtube connected -> throws NO_CONNECTIONS
// 3. targetPlatforms undefined -> results for every connection (existing behavior preserved)
// buildPublishMetadataSnapshot:
// 4. (undefined, undefined, ["x"]) -> { targetPlatforms: ["x"] }
// 5. (undefined, undefined, undefined) -> undefined
// 6. (tiktokMeta, undefined, ["tiktok","x"]) -> { tiktok: …, targetPlatforms: ["tiktok","x"] }
```

`src/server/jobs/deferredDispatch.test.ts` — add:

```ts
// 7. job with publishMetadata.targetPlatforms ["youtube"], connections youtube+x
//    -> creates result rows for youtube only
// 8. job with targetPlatforms ["tiktok"], connections youtube only
//    -> marks job failed, returns { ok: false, reason: "NO_CONNECTIONS" }
```

Run both files → FAIL.

- [ ] **Step 2: Implement in `posting.ts`**

- `PostJobSchedulingParams` (or both create-param interfaces) gains `targetPlatforms?: Platform[];` documented as: chosen subset of the user's connected platforms; `undefined` = all connections (legacy behavior).
- `buildPublishMetadataSnapshot(tiktokMetadata?, youtubeMetadata?, targetPlatforms?)`: returns `undefined` only when all three are absent/empty; includes `targetPlatforms` when it is a non-empty array.
- In `createPostJobOnly` and `createPostJobForExistingMedia`: after loading `socialConnections` (immediate intent), filter `const targeted = targetPlatforms ? socialConnections.filter((c) => targetPlatforms.includes(c.platform)) : socialConnections;` — the `NO_CONNECTIONS` throw and the result-row `createMany` both use `targeted`. Pass `targetPlatforms` into the snapshot builder for the deferred persist.
- In `prepareDeferredPostJobDispatch`: after loading `connections`, read the snapshot first, then filter:

```ts
const publishMetadata = (job.publishMetadata as PublishMetadataSnapshot | null) ?? null;
const target = publishMetadata?.targetPlatforms;
const eligible = target?.length
  ? connections.filter((c) => target.includes(c.platform))
  : connections;
```

`eligible` replaces `connections` in both the zero-check (job → failed) and the result `createMany`. Run the two test files → PASS.

- [ ] **Step 3: Route validation** (`src/app/api/posts/route.ts` + route.test.ts)

Add failing route tests first (follow `route.test.ts` conventions):

```ts
// platforms: "youtube" (not an array)        -> 400 "platforms must be an array of platform names"
// platforms: ["youtube", "myspace"]          -> 400 mentions "myspace"
// platforms: []                              -> 400 "Select at least one platform."
// platforms: ["youtube","youtube"]           -> passes a deduped ["youtube"] to the create helper
// platforms absent                           -> create helper called with targetPlatforms undefined
```

Implementation: `CreatePostBody` gains `platforms?: unknown`. After the tiktok-metadata validation block:

```ts
const VALID_PLATFORMS = new Set<string>(Object.values(Platform));
let targetPlatforms: Platform[] | undefined;
if (body?.platforms != null) {
  if (!Array.isArray(body.platforms) || body.platforms.some((p) => typeof p !== "string")) {
    return NextResponse.json(
      { error: "platforms must be an array of platform names" },
      { status: 400 },
    );
  }
  const unknown = body.platforms.filter((p) => !VALID_PLATFORMS.has(p));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown platform(s): ${unknown.join(", ")}` },
      { status: 400 },
    );
  }
  const deduped = Array.from(new Set(body.platforms)) as Platform[];
  if (deduped.length === 0) {
    return NextResponse.json({ error: "Select at least one platform." }, { status: 400 });
  }
  targetPlatforms = deduped;
}
```

(`Platform` must be imported as a value: `import { PostJobStatus, Platform, type Prisma } from "@prisma/client";`.) Pass `targetPlatforms` to both create helpers. Run tests → PASS.

- [ ] **Step 4: Composer targeting UI**

In `create-post-form.tsx`:
- State: `const [deselected, setDeselected] = useState<Set<Platform>>(new Set());` and `const selectedPlatforms = useMemo(() => connectedPlatforms.filter((p) => !deselected.has(p)), [connectedPlatforms, deselected]);` (default = everything connected; platforms that finish loading later arrive selected). Reset `deselected` to `new Set()` in the post-success reset block.
- UI, rendered between the TikTok/YouTube settings panels and `PlatformPreviewList`, only when `connectedPlatforms.length > 0`:

```tsx
<fieldset className="space-y-1.5">
  <legend className="text-sm font-medium text-foreground">Publish to</legend>
  <div className="flex flex-wrap gap-2">
    {connectedPlatforms.map((platform) => {
      const checked = !deselected.has(platform);
      return (
        <label
          key={platform}
          className={cn(
            "inline-flex cursor-pointer items-center gap-2 rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors",
            checked
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-input text-muted-foreground hover:text-foreground",
          )}
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-input accent-[var(--primary)]"
            checked={checked}
            onChange={(event) => {
              setDeselected((prev) => {
                const next = new Set(prev);
                if (event.target.checked) next.delete(platform);
                else next.add(platform);
                return next;
              });
            }}
          />
          {platformLabel(platform)}
        </label>
      );
    })}
  </div>
  {selectedPlatforms.length === 0 ? (
    <p className="text-xs text-destructive" role="alert">
      Select at least one platform.
    </p>
  ) : null}
</fieldset>
```

(Import `platformLabel` from `@/lib/platforms`.)
- `PlatformPreviewList` gets `platforms={selectedPlatforms}`.
- TikTok/YouTube panels additionally hide when deselected: `hasTikTokConnection && !deselected.has("tiktok") && activeMimeType && …` (same for youtube). The TikTok privacy requirement check gains `&& !deselected.has("tiktok")`, and `blobData.tiktokMetadata`/`youtubeMetadata` are attached only when the platform is selected (`hasTikTokConnection && selectedPlatforms.includes("tiktok")` etc., both branches).
- Submit guard after the caption check: `if (selectedPlatforms.length === 0) { setUploadError("Select at least one platform to publish to."); return; }`
- Request bodies (`reuseData` and `blobData`) gain `platforms: selectedPlatforms`.

- [ ] **Step 5: Publish-now confirmation dialog**

Refactor `handleUploadSubmit`: extract everything from `setUploadLoading(true)` down into `async function performSubmit()`. The submit handler runs the validations (file/caption/schedule/tiktok privacy via the existing checks — keep them BEFORE the dialog so the dialog only opens on a valid form), then:

```ts
if (publishMode === "now") {
  setConfirmPublishOpen(true);
  return;
}
await performSubmit();
```

Add `const [confirmPublishOpen, setConfirmPublishOpen] = useState(false);` and render:

```tsx
<ConfirmDialog
  open={confirmPublishOpen}
  onOpenChange={setConfirmPublishOpen}
  title={`Publish to ${selectedPlatforms.length} ${selectedPlatforms.length === 1 ? "platform" : "platforms"} now?`}
  description={
    <span className="block space-y-1">
      <span className="block">{selectedPlatforms.map(platformLabel).join(", ")}</span>
      {selectedPlatforms.includes("youtube") ? (
        <span className="block">YouTube privacy: {youtubeMetadata.privacyStatus}</span>
      ) : null}
      {selectedPlatforms.includes("tiktok") && tiktokMetadata.privacyLevel ? (
        <span className="block">TikTok privacy: {TIKTOK_PRIVACY_LABELS[tiktokMetadata.privacyLevel] ?? tiktokMetadata.privacyLevel}</span>
      ) : null}
      <span className="block">This publishes immediately and can&apos;t be undone here.</span>
    </span>
  }
  confirmText="Publish now"
  onConfirm={performSubmit}
/>
```

with `const TIKTOK_PRIVACY_LABELS: Record<string, string> = { PUBLIC_TO_EVERYONE: "Public (everyone)", MUTUAL_FOLLOW_FRIENDS: "Friends", SELF_ONLY: "Private (only me)", FOLLOWER_OF_CREATOR: "Followers" };` at module scope. `ConfirmDialog` import from `@/components/ui/dialog`. Note `ConfirmDialog`'s `description` prop is `ReactNode` — the JSX above is valid. `performSubmit` must `throw` on failure only if you want the dialog held open; simpler contract: `performSubmit` handles its own toasts and never throws (dialog closes; errors surface via toast/alert as today) — implement that by keeping its current try/catch.

- [ ] **Step 6: Sync e2e + verify + commit**

`app/e2e/core-flows.spec.ts` compose-flow ("compose a post and see it land in Activity"): after `form.getByRole("button", { name: "Publish post" }).click();` insert:

```ts
// Publish-now confirmation dialog (per-post platform targeting change)
await page
  .getByRole("dialog")
  .getByRole("button", { name: "Publish now" })
  .click();
```

(The schedule flow has no dialog — schedule submits directly.)

Run: `npx vitest run src/server/jobs/posting.test.ts src/server/jobs/deferredDispatch.test.ts src/app/api/posts/route.test.ts`, then `npm test`, `npm run lint`, and `npm run build` (this task touches server+client seams — the type-check matters).

```bash
git add src/server/jobs/posting.ts src/server/jobs/posting.test.ts src/server/jobs/deferredDispatch.test.ts src/app/api/posts/route.ts src/app/api/posts/route.test.ts src/components/create-post-form.tsx e2e/core-flows.spec.ts
git commit -m "feat(composer): per-post platform targeting + publish-now confirmation"
```

---

### Task 8: Activity/Queue/Dashboard — polling, richer cards, post links, single fetch

**Files:**
- Modify: `src/lib/postsDto.ts`
- Create: `src/lib/platformPostUrl.ts` + `src/lib/platformPostUrl.test.ts`
- Modify: `src/app/api/posts/route.ts` (GET only) + `src/app/api/posts/route.get.test.ts`
- Modify: `src/hooks/usePostJobs.ts`
- Modify: `src/components/activity/post-job-card.tsx`
- Modify: `src/app/activity/activity-view.tsx`
- Modify: `src/app/queue/queue-view.tsx`
- Modify: `src/app/page.tsx`, `src/components/dashboard/recent-activity.tsx`, `src/components/dashboard/youtube-metrics-summary.tsx`

**Interfaces:**
- Consumes: `publishMetadata.targetPlatforms` (Task 7).
- Produces: `PostJobDTO` gains `media: { url: string; mimeType: string } | null` and `publish: { targetPlatforms: Platform[] | null; youtubePrivacy: string | null; tiktokPrivacy: string | null } | null`. `usePostJobs` polls while work is in flight. `RecentActivity` and `YouTubeMetricsSummary` take `{ jobs, loading, error, reload }` props instead of fetching.

- [ ] **Step 1: `platformPostUrl` helper (TDD)**

Test first (`src/lib/platformPostUrl.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { platformPostUrl } from "./platformPostUrl";

describe("platformPostUrl", () => {
  it("builds a YouTube watch URL", () => {
    expect(platformPostUrl("youtube", "abc123")).toBe("https://www.youtube.com/watch?v=abc123");
  });
  it("builds an X status URL", () => {
    expect(platformPostUrl("x", "190123")).toBe("https://x.com/i/web/status/190123");
  });
  it("builds a LinkedIn update URL from an URN", () => {
    expect(platformPostUrl("linkedin", "urn:li:share:7100")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:share:7100",
    );
  });
  it("builds a Facebook post URL", () => {
    expect(platformPostUrl("facebook_page", "111_222")).toBe("https://www.facebook.com/111_222");
  });
  it("returns null where no public URL is derivable from the id alone", () => {
    expect(platformPostUrl("tiktok", "v_pub_url~x")).toBeNull();
    expect(platformPostUrl("instagram", "1789")).toBeNull();
    expect(platformPostUrl("google_business_profile", "loc/media/1")).toBeNull();
  });
  it("returns null for a missing id", () => {
    expect(platformPostUrl("youtube", null)).toBeNull();
    expect(platformPostUrl("youtube", "")).toBeNull();
  });
});
```

Implementation (`src/lib/platformPostUrl.ts`):

```ts
import type { Platform } from "@prisma/client";

/**
 * Public URL of a published post, derivable from the stored externalPostId
 * alone — or null where the id isn't a public locator (TikTok publish ids,
 * Instagram media ids, GBP media names).
 */
export function platformPostUrl(platform: Platform, externalPostId: string | null): string | null {
  if (!externalPostId) return null;
  switch (platform) {
    case "youtube":
      return `https://www.youtube.com/watch?v=${encodeURIComponent(externalPostId)}`;
    case "x":
      return `https://x.com/i/web/status/${encodeURIComponent(externalPostId)}`;
    case "linkedin":
      return `https://www.linkedin.com/feed/update/${encodeURIComponent(externalPostId)}`;
    case "facebook_page":
      return `https://www.facebook.com/${encodeURIComponent(externalPostId)}`;
    default:
      return null;
  }
}
```

- [ ] **Step 2: Extend the DTO + GET route**

`src/lib/postsDto.ts` — add to `PostJobDTO`:

```ts
/** Attached media for thumbnails (public blob URL — already exposed via /api/media). */
media: { url: string; mimeType: string } | null;
/**
 * Compose-time publish choices snapshotted on the job (Roadmap Phase 5 +
 * targeting). Null for legacy/immediate jobs with no snapshot.
 */
publish: {
  targetPlatforms: Platform[] | null;
  youtubePrivacy: string | null;
  tiktokPrivacy: string | null;
} | null;
```

`src/app/api/posts/route.ts` GET: extend the `select` — `mediaItem: { select: { baseCaption: true, storageLocation: true, mimeType: true } }` and add `publishMetadata: true`. In the payload map:

```ts
const snapshot = job.publishMetadata as {
  tiktok?: { privacyLevel?: string };
  youtube?: { privacyStatus?: string };
  targetPlatforms?: string[];
} | null;
// …
media: job.mediaItem
  ? { url: job.mediaItem.storageLocation, mimeType: job.mediaItem.mimeType }
  : null,
publish: snapshot
  ? {
      targetPlatforms: (snapshot.targetPlatforms as Platform[] | undefined) ?? null,
      youtubePrivacy: snapshot.youtube?.privacyStatus ?? null,
      tiktokPrivacy: snapshot.tiktok?.privacyLevel ?? null,
    }
  : null,
```

Extend `src/app/api/posts/route.get.test.ts`: the mocked job rows gain `publishMetadata` + mediaItem fields; assert `media.url`, `publish.youtubePrivacy`, and `publish.targetPlatforms` round-trip, and that a null `publishMetadata` maps to `publish: null`. SEC check stays: no new secret-bearing fields (storageLocation is a public blob URL, already exposed by `/api/media`).

- [ ] **Step 3: Poll while work is in flight**

Rewrite `src/hooks/usePostJobs.ts` to keep polling every 10s while any job is `in_progress` or any result is `pending` (covers fresh publishes AND retries):

```ts
const POLL_INTERVAL_MS = 10_000;

function hasWorkInFlight(jobs: PostJobDTO[] | null): boolean {
  return (
    jobs?.some(
      (job) =>
        job.status === "in_progress" ||
        job.results.some((result) => result.status === "pending"),
    ) ?? false
  );
}
```

- `load` keeps its shape but no longer flips `loading` on background refreshes: give it `load(options?: { background?: boolean })`; background loads skip `setLoading(true)` (so polling never blanks the UI into skeletons).
- Add an effect: `useEffect(() => { if (!hasWorkInFlight(jobs)) return; const t = setTimeout(() => { void load({ background: true }); }, POLL_INTERVAL_MS); return () => clearTimeout(t); }, [jobs, load]);`
- `reload` (exposed) stays a foreground load.

- [ ] **Step 4: PostJobCard — clear optimistic state on refresh, failure explanation, view links, a11y**

In `src/components/activity/post-job-card.tsx`:
- Clear optimistic retry state whenever fresh server data arrives: `useEffect(() => { setPending(new Set()); setReconnect((prev) => (prev.size ? prev : prev)); }, [job]);` — precisely: reset `pending` only. (Polling delivers new `job` object identities every 10s; the server itself marks a retried result `pending`, so the UI stays truthful and finally resolves to success/failed. Keep `reconnect` — it's server-derived knowledge, not optimism.)
- Zero-result failure explanation — after the results row, add:

```tsx
{job.status === "failed" && results.length === 0 ? (
  <p className="mt-3 rounded-[var(--radius)] border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-foreground">
    This post failed because no platforms were connected when it ran. Connect a
    platform in <Link href="/settings" className="font-medium text-primary underline underline-offset-2">Settings</Link> and create it again.
  </p>
) : null}
```

- View links — under the pills row:

```tsx
{results.some((r) => r.status === "success" && platformPostUrl(r.platform, r.externalPostId)) ? (
  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
    {results.map((result) => {
      const url = result.status === "success" ? platformPostUrl(result.platform, result.externalPostId) : null;
      if (!url) return null;
      return (
        <a
          key={result.platform}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          View on {platformLabel(result.platform)}
          <ExternalLink aria-hidden className="h-3 w-3" />
        </a>
      );
    })}
  </div>
) : null}
```

(Imports: `platformPostUrl`, `ExternalLink` from lucide.)
- Media thumbnail: at the start of the header flex row, when `job.media` render a 48px thumb — image (`<img src={job.media.url} alt="" className="h-12 w-12 shrink-0 rounded-[var(--radius)] border border-border object-cover" />`, with the same eslint-disable comment used in `create-post-form.tsx` for blob-URL `<img>`) or, for video mimeTypes, `<video src={job.media.url} muted playsInline preload="metadata" aria-hidden tabIndex={-1} className="h-12 w-12 shrink-0 rounded-[var(--radius)] border border-border object-cover" />`.

- [ ] **Step 5: Queue cards — platforms, privacy, thumbnail, year, a11y labels**

In `src/app/queue/queue-view.tsx`:
- `formatTimestamp`: add `year: "numeric"` to the options.
- In `QueueCard`, reuse the same thumbnail block as Step 4 (job.media).
- Under the scheduled/saved line add target + privacy summary:

```tsx
<p className="mt-1 text-xs text-muted-foreground">
  {job.publish?.targetPlatforms?.length
    ? `Publishing to ${job.publish.targetPlatforms.map(platformLabel).join(", ")}`
    : "Publishing to all platforms connected at publish time"}
  {job.publish?.youtubePrivacy ? ` · YouTube: ${job.publish.youtubePrivacy}` : ""}
  {job.publish?.tiktokPrivacy ? ` · TikTok: ${TIKTOK_PRIVACY_LABELS[job.publish.tiktokPrivacy] ?? job.publish.tiktokPrivacy}` : ""}
</p>
```

with the same `TIKTOK_PRIVACY_LABELS` map as Task 7 Step 5 — define it once in `src/lib/platforms.ts` as an exported const in THIS task, and update Task 7's composer import to use it if Task 7 already landed a local copy (delete the local copy).
- Per-item accessible names: `aria-label={`Edit "${job.caption?.trim() || "Untitled post"}"`}` on Edit, and equivalents for "Publish now"/"Cancel"/"Delete".

- [ ] **Step 6: Dashboard single fetch + activity copy**

- `src/components/dashboard/recent-activity.tsx` and `youtube-metrics-summary.tsx`: change both to accept `{ jobs, loading, error, reload }: UsePostJobsResult` as props and delete their internal `usePostJobs()` calls (YouTubeMetricsSummary only needs `jobs` — accept just `{ jobs }`).
- `src/app/page.tsx`: `Dashboard` becomes the single `usePostJobs()` caller and passes props down. (`page.tsx` is already `"use client"`.)
- `src/app/activity/activity-view.tsx` subtitle → "Everything you've created — drafts, scheduled posts, and how each platform responded."

- [ ] **Step 7: Verify and commit**

Run: `npx vitest run src/lib/platformPostUrl.test.ts src/app/api/posts/route.get.test.ts`, `npm test`, `npm run lint`, `npm run build`.

```bash
git add src/lib/postsDto.ts src/lib/platformPostUrl.ts src/lib/platformPostUrl.test.ts src/lib/platforms.ts src/app/api/posts/route.ts src/app/api/posts/route.get.test.ts src/hooks/usePostJobs.ts src/components/activity/post-job-card.tsx src/app/activity/activity-view.tsx src/app/queue/queue-view.tsx src/app/page.tsx src/components/dashboard/recent-activity.tsx src/components/dashboard/youtube-metrics-summary.tsx
git commit -m "feat(activity+queue): live polling, richer cards with media/platforms/privacy, view-on-platform links, single dashboard fetch"
```

---

### Task 9: Notify on zero-connection scheduled failure

**Files:**
- Modify: `src/server/notifications/postOutcomeEmail.ts` + `src/server/notifications/postOutcomeEmail.test.ts`
- Modify: `src/server/jobs/inngest-functions.ts` (scheduled scanner NO_CONNECTIONS branch)
- Modify: `src/server/jobs/posting.ts` (remove the KNOWN GAP comment block once fixed)

**Interfaces:**
- Consumes: existing `notification.requested` Inngest event `{ userId, postJobId }` (see `inngest-functions.ts:598-605`).

- [ ] **Step 1: Read `postOutcomeEmail.ts` and its test, then add a failing test**

A failed job with ZERO results must produce a distinct email (today empty results reads as a neutral "finished"). Add to `postOutcomeEmail.test.ts` (follow its existing builder-call conventions):

```ts
// buildPostOutcomeEmail for a job { status: "failed", results: [] } ->
//   subject contains "couldn't be published"
//   body/text contains "no connected platforms" and "Settings"
```

Run → FAIL.

- [ ] **Step 2: Implement the empty-results branch**

In `buildPostOutcomeEmail`, before the per-platform sections: when `results.length === 0 && job.status === "failed"`, return subject `Your scheduled post couldn't be published` with body copy: `This post had no connected platforms when it ran, so nothing was published. Connect a platform in Settings, then create the post again.` — matching the file's existing text/html structure. Run test → PASS.

- [ ] **Step 3: Emit the notification from the scanner**

In `inngest-functions.ts`, the scheduled scanner's `else if (prep.reason === "NO_CONNECTIONS")` branch (line ~663) currently only counts. Add an exactly-once notification send. `prepareDeferredPostJobDispatch` doesn't return the userId, so fetch it in a memoized step:

```ts
} else if (prep.reason === "NO_CONNECTIONS") {
  failedNoConnections += 1;
  // Phase-6 gap closed: the unattended "no platforms connected" failure now
  // notifies like every other outcome. Memoized step => exactly-once.
  const owner = await step.run(`owner-${postJobId}`, async () => {
    return prisma.postJob.findUnique({
      where: { id: postJobId },
      select: { userId: true },
    });
  });
  if (owner) {
    await step.sendEvent(`notify-noconn-${postJobId}`, {
      name: "notification.requested",
      data: { userId: owner.userId, postJobId },
    });
  }
}
```

- [ ] **Step 4: Retire the KNOWN GAP comment**

In `src/server/jobs/posting.ts` (~lines 448-456), replace the KNOWN GAP paragraph with: `// The scheduled scanner emits notification.requested for this failure (see inngest-functions.ts) and buildPostOutcomeEmail has a dedicated empty-results-failed subject.`

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run src/server/notifications/postOutcomeEmail.test.ts`, `npm test`, `npm run lint`.

```bash
git add src/server/notifications/postOutcomeEmail.ts src/server/notifications/postOutcomeEmail.test.ts src/server/jobs/inngest-functions.ts src/server/jobs/posting.ts
git commit -m "fix(notifications): email on zero-connection scheduled failure (closes Phase-6 gap)"
```

---

### Task 10: Consistency sweep + shell polish + full gate

**Files:**
- Modify: `src/lib/platforms.ts`
- Modify: `src/components/connections-section.tsx`
- Modify: `src/components/shell/account-menu.tsx`, `src/components/shell/top-bar.tsx`, `src/components/shell/app-shell.tsx`
- Modify: `src/components/youtube-post-settings.tsx`
- Modify: `src/app/activity/page.tsx` or remaining files ONLY if the greps below hit them

- [ ] **Step 1: Unify platform labels**

`src/lib/platforms.ts`: `facebook_page: "Facebook"` → `"Facebook Page"`; `google_business_profile: "Google Business"` → `"Google Business Profile"`. Then `grep -rn "platformLabel\|PLATFORM_LABELS" src --include=*.tsx -l` and eyeball each rendering site for layout tolerance (pills wrap — fine). In `connections-section.tsx` set each PLATFORMS `label` to exactly the `PLATFORM_LABELS` value ("X" not "X (Twitter)", "Google Business Profile" not "…(Maps)", "Facebook Page") and keep the parenthetical context in `description` instead. TikTok description → "Connect your TikTok account. Videos are sent to your TikTok inbox as drafts — you finish and publish them in the TikTok app."

- [ ] **Step 2: Shell polish**

- `account-menu.tsx`: `aria-haspopup="true"` → `aria-haspopup="dialog"`.
- `top-bar.tsx`: show the section title on mobile too — change the title span to `className="min-w-0 truncate text-sm font-semibold text-foreground"` (drop `hidden`/`md:inline`) and keep the mobile Brand; the flex row + truncate absorbs narrow widths.
- `app-shell.tsx`: eliminate the bare-content flash on authenticated loads. Every non-public route except `/` server-redirects unauthenticated users (Tasks 3/4 + settings), so rendering the chrome optimistically while the session loads is safe there:

```ts
const isAppRoute = !isPublicRoute(pathname) && pathname !== "/";
const showShell =
  isAppRoute && (status === "authenticated" || status === "loading");
```

(Keep `"/"` behavior exactly as today: bare while loading, Landing when signed out, Dashboard+shell when signed in — so also keep `!isPublicRoute(pathname) && status === "authenticated"` as an OR-branch for `/`: final expression `const showShell = status === "authenticated" ? !isPublicRoute(pathname) : isAppRoute && status === "loading";`.)

- [ ] **Step 3: Casing sweep**

`youtube-post-settings.tsx`: "YouTube Post Settings" → "YouTube post settings". Run `grep -rnE '>[A-Z][a-z]+ [A-Z][a-z]+' src/components src/app --include=*.tsx | grep -v "Vibe Socials"` and sentence-case any remaining UI literals the earlier tasks missed (skip proper nouns: TikTok, YouTube, LinkedIn, Google Business Profile, Facebook Page, X).

- [ ] **Step 4: Full gate**

Run, in order, from `app/`:
1. `npm test` → all green (354 baseline + new).
2. `npm run lint` → no errors.
3. `npm run build` → exit 0.
4. `npx playwright test` → 16 passed, 4 skipped (this is the ONLY task allowed to run playwright; its webServer uses a dummy DATABASE_URL and only exercises public routes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/platforms.ts src/components/connections-section.tsx src/components/shell src/components/youtube-post-settings.tsx
git commit -m "polish: unified platform labels, shell loading chrome, aria-haspopup, sentence-case sweep"
```

---

## Self-review notes (spec coverage)

Backlog item → task: #1→T2, #2→T6, #3→T1, #4→T4, #5→T2, #6→T3, #7→T6, #8→T8, #9→T8+T9, #10→T5, #11→T8, #12→T7, #13→T6, #14→T8, #15→T3, #16→T5, #17→T4, #18→T2, #19→T1, #20→T7, #21→T4/T6/T8/T10, #22→T2, #23 (hint variant)→T3. Deliberately out of scope (documented, needs owner/product decision): full password-reset email flow (needs RESEND config), pagination beyond 50 jobs, per-platform caption override editor, dashboard queue widget.
