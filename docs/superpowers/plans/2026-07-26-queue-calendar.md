# Queue Calendar View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A month calendar view on the Queue page showing scheduled posts on their days, with drag-to-reschedule (HTML5 DnD, no new dependencies) that PATCHes `scheduledFor` through the existing edit API.

**Architecture:** All date math is a pure module (`lib/queueCalendar.ts`, table-driven tests): month-grid builder, local-day grouping, and a `retargetSchedule` rule that preserves time-of-day and refuses past targets. The component (`app/queue/queue-calendar.tsx`) renders the grid and chips; `QueueView` gains a List/Calendar toggle and passes down its existing `jobs` state + an `onRescheduled` updater. Reschedule = `PATCH /api/posts/{id}` with `{ scheduledFor }` (verified: PATCH accepts partial bodies). Clicking a chip opens the EXISTING edit dialog (`setEditTarget`) — that is also the keyboard-accessible alternative to drag.

**Tech Stack:** React client components, Tailwind (repo utility classes), HTML5 drag & drop, Vitest for the pure module. No new packages.

## Global Constraints

- No new npm dependencies.
- Calendar shows SCHEDULED jobs only; drafts (no date) stay in the List view. When drafts exist, the calendar shows a one-line note: `N draft(s) — see List view`.
- All day keys are the BROWSER-LOCAL date `YYYY-MM-DD` (the queue already renders times in local tz — `localTimeZoneLabel()`); weeks start on Sunday.
- Drag preserves the post's original local time-of-day; a drop that lands in the past (or within `SCHEDULE_BUFFER_MS` of now, from `@/lib/scheduling`) is rejected with a toast, not clamped.
- List stays the default view; the toggle is `useState` only (no persistence — YAGNI).
- Reuse `PostJobDTO` from `@/lib/postsDto` (fields used: `id`, `status`, `caption`, `scheduledFor`, `publish.targetPlatforms`).
- Commit style: `<type>(scope): summary` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; branch `feat/queue-calendar`; one PR.

---

### Task 1: Pure calendar module

**Files:**
- Create: `app/src/lib/queueCalendar.ts`
- Create: `app/src/lib/queueCalendar.test.ts`

**Interfaces:**
- Produces (consumed by Task 2's component):
  - `type CalendarDay = { key: string; dayOfMonth: number; inMonth: boolean }`
  - `buildCalendarMonth(year: number, monthIndex: number): CalendarDay[][]` — 7-column weeks covering the month, Sunday-start, padded with adjacent-month days (`inMonth: false`).
  - `localDayKey(date: Date): string` — `YYYY-MM-DD` from LOCAL date parts.
  - `groupJobsByDay<T extends { scheduledFor: string | null }>(jobs: T[]): Map<string, T[]>` — scheduled-only (non-null `scheduledFor`), keyed by `localDayKey`, each day sorted ascending by time.
  - `retargetSchedule(originalIso: string, dayKey: string, now: Date, bufferMs: number): string | null` — new ISO preserving local time-of-day on the target day; `null` when the result is `< now + bufferMs`.

- [ ] **Step 1: Write the failing tests** — create `app/src/lib/queueCalendar.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  buildCalendarMonth,
  groupJobsByDay,
  localDayKey,
  retargetSchedule,
} from "./queueCalendar";

// All dates below are constructed from LOCAL components so the tests are
// timezone-independent (the module's contract is browser-local days).

describe("localDayKey", () => {
  it("formats local date parts with zero padding", () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDayKey(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });
});

describe("buildCalendarMonth", () => {
  it("covers July 2026 in Sunday-start weeks with padded edges", () => {
    const weeks = buildCalendarMonth(2026, 6); // July 2026: 1st is a Wednesday
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // First cell is Sunday June 28; last week ends Saturday August 1.
    expect(weeks[0][0]).toMatchObject({ key: "2026-06-28", inMonth: false });
    expect(weeks[0][3]).toMatchObject({ key: "2026-07-01", dayOfMonth: 1, inMonth: true });
    const lastWeek = weeks[weeks.length - 1];
    expect(lastWeek[6]).toMatchObject({ key: "2026-08-01", inMonth: false });
    // Every July day is present exactly once and marked inMonth.
    const julyDays = weeks.flat().filter((d) => d.inMonth);
    expect(julyDays).toHaveLength(31);
  });

  it("handles February in a leap year", () => {
    const days = buildCalendarMonth(2028, 1).flat().filter((d) => d.inMonth);
    expect(days).toHaveLength(29);
  });
});

describe("groupJobsByDay", () => {
  it("groups scheduled jobs by local day, sorted by time, skipping null dates", () => {
    const at = (d: Date) => d.toISOString();
    const jobs = [
      { id: "b", scheduledFor: at(new Date(2026, 6, 15, 14, 0)) },
      { id: "a", scheduledFor: at(new Date(2026, 6, 15, 9, 30)) },
      { id: "other-day", scheduledFor: at(new Date(2026, 6, 16, 8, 0)) },
      { id: "draft", scheduledFor: null },
    ];
    const grouped = groupJobsByDay(jobs);
    expect(grouped.get("2026-07-15")?.map((j) => (j as { id: string }).id)).toEqual(["a", "b"]);
    expect(grouped.get("2026-07-16")).toHaveLength(1);
    expect([...grouped.values()].flat()).toHaveLength(3);
  });
});

describe("retargetSchedule", () => {
  const NOW = new Date(2026, 6, 15, 12, 0); // local noon, Jul 15 2026
  const BUFFER = 60_000;

  it("moves the date but preserves the local time-of-day", () => {
    const original = new Date(2026, 6, 20, 9, 30).toISOString();
    const result = retargetSchedule(original, "2026-07-22", NOW, BUFFER);
    expect(result).not.toBeNull();
    const moved = new Date(result!);
    expect(localDayKey(moved)).toBe("2026-07-22");
    expect(moved.getHours()).toBe(9);
    expect(moved.getMinutes()).toBe(30);
  });

  it("rejects a target in the past", () => {
    const original = new Date(2026, 6, 20, 9, 30).toISOString();
    expect(retargetSchedule(original, "2026-07-10", NOW, BUFFER)).toBeNull();
  });

  it("rejects a same-day move whose preserved time already passed", () => {
    const original = new Date(2026, 6, 20, 9, 30).toISOString(); // 09:30 < NOW 12:00
    expect(retargetSchedule(original, "2026-07-15", NOW, BUFFER)).toBeNull();
  });

  it("allows a same-day move whose preserved time is still ahead of the buffer", () => {
    const original = new Date(2026, 6, 20, 18, 0).toISOString();
    const result = retargetSchedule(original, "2026-07-15", NOW, BUFFER);
    expect(result).not.toBeNull();
  });

  it("returns null for an invalid day key", () => {
    const original = new Date(2026, 6, 20, 9, 30).toISOString();
    expect(retargetSchedule(original, "not-a-day", NOW, BUFFER)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — must FAIL** (`npx vitest run src/lib/queueCalendar.test.ts`, module missing)

- [ ] **Step 3: Implement `app/src/lib/queueCalendar.ts`**

```typescript
/**
 * Queue calendar — pure date math for the month view (no Date.now(), no DOM).
 * All "days" are BROWSER-LOCAL dates keyed "YYYY-MM-DD", matching how the
 * queue already displays times (localTimeZoneLabel()). Weeks start Sunday.
 */

export interface CalendarDay {
  key: string;
  dayOfMonth: number;
  inMonth: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toCalendarDay(date: Date, monthIndex: number): CalendarDay {
  return {
    key: localDayKey(date),
    dayOfMonth: date.getDate(),
    inMonth: date.getMonth() === monthIndex,
  };
}

/** Sunday-start weeks covering the given month, padded with adjacent days. */
export function buildCalendarMonth(year: number, monthIndex: number): CalendarDay[][] {
  const first = new Date(year, monthIndex, 1);
  const start = new Date(year, monthIndex, 1 - first.getDay());
  const weeks: CalendarDay[][] = [];
  const cursor = new Date(start);
  do {
    const week: CalendarDay[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(toCalendarDay(cursor, monthIndex));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  } while (cursor.getMonth() === monthIndex);
  return weeks;
}

/** Scheduled jobs grouped by local day key, each day's list sorted by time. */
export function groupJobsByDay<T extends { scheduledFor: string | null }>(
  jobs: T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const job of jobs) {
    if (!job.scheduledFor) continue;
    const key = localDayKey(new Date(job.scheduledFor));
    const bucket = grouped.get(key);
    if (bucket) bucket.push(job);
    else grouped.set(key, [job]);
  }
  for (const bucket of grouped.values()) {
    bucket.sort(
      (a, b) => new Date(a.scheduledFor!).getTime() - new Date(b.scheduledFor!).getTime(),
    );
  }
  return grouped;
}

/**
 * Drop rule for drag-to-reschedule: keep the post's local time-of-day, move it
 * to `dayKey`. Returns the new ISO string, or null when the day key is
 * malformed or the resulting instant is less than `now + bufferMs` away
 * (past days, and same-day moves whose time already passed) — the caller
 * shows a toast instead of clamping.
 */
export function retargetSchedule(
  originalIso: string,
  dayKey: string,
  now: Date,
  bufferMs: number,
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const original = new Date(originalIso);
  if (Number.isNaN(original.getTime())) return null;
  const target = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    original.getHours(),
    original.getMinutes(),
    original.getSeconds(),
    original.getMilliseconds(),
  );
  if (target.getTime() < now.getTime() + bufferMs) return null;
  return target.toISOString();
}
```

- [ ] **Step 4: Run — PASS**; run full suite (`npm test`) — all green.

- [ ] **Step 5: Commit** — `feat(queue): pure calendar month/grouping/retarget rules` (branch `feat/queue-calendar`).

---

### Task 2: Calendar component + Queue toggle

**Files:**
- Create: `app/src/app/queue/queue-calendar.tsx`
- Modify: `app/src/app/queue/queue-view.tsx` (view toggle, render calendar, `onRescheduled` state updater)

**Interfaces:**
- Consumes from Task 1: `buildCalendarMonth`, `groupJobsByDay`, `localDayKey`, `retargetSchedule`, `CalendarDay`; `SCHEDULE_BUFFER_MS`, `localTimeZoneLabel` from `@/lib/scheduling`; `platformLabel` from `@/lib/platforms`; `PostJobDTO` from `@/lib/postsDto`; `useToast` from `@/components/ui/toast`; `Button` from `@/components/ui/button`; `cn` from `@/lib/cn`.
- Produces: `<QueueCalendar jobs={PostJobDTO[]} onEdit={(job) => void} onRescheduled={(id: string, scheduledFor: string) => void} />` (named export `QueueCalendar`).

- [ ] **Step 1: Implement `app/src/app/queue/queue-calendar.tsx`** (no unit-test infra for components in this repo — the pure logic is already covered; verification is Step 4's build/lint/e2e + Step 6's live prod check):

```tsx
"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { platformLabel } from "@/lib/platforms";
import type { PostJobDTO } from "@/lib/postsDto";
import {
  buildCalendarMonth,
  groupJobsByDay,
  localDayKey,
  retargetSchedule,
} from "@/lib/queueCalendar";
import { SCHEDULE_BUFFER_MS, localTimeZoneLabel } from "@/lib/scheduling";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTH_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

interface QueueCalendarProps {
  jobs: PostJobDTO[];
  /** Open the existing edit dialog — also the keyboard path to reschedule. */
  onEdit: (job: PostJobDTO) => void;
  /** Applied AFTER a successful PATCH so the list view stays in sync. */
  onRescheduled: (id: string, scheduledFor: string) => void;
}

/** Month calendar of scheduled posts. Drag a chip onto a day to reschedule
 *  (preserves its time-of-day); click a chip to edit. Drafts have no date and
 *  stay in the List view. */
export function QueueCalendar({ jobs, onEdit, onRescheduled }: QueueCalendarProps) {
  const toast = useToast();
  const [monthCursor, setMonthCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), monthIndex: now.getMonth() };
  });
  const [dragJobId, setDragJobId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const scheduled = useMemo(() => jobs.filter((j) => j.status === "scheduled"), [jobs]);
  const draftCount = jobs.length - scheduled.length;
  const weeks = useMemo(
    () => buildCalendarMonth(monthCursor.year, monthCursor.monthIndex),
    [monthCursor],
  );
  const byDay = useMemo(() => groupJobsByDay(scheduled), [scheduled]);
  const todayKey = localDayKey(new Date());

  function shiftMonth(delta: number) {
    setMonthCursor(({ year, monthIndex }) => {
      const d = new Date(year, monthIndex + delta, 1);
      return { year: d.getFullYear(), monthIndex: d.getMonth() };
    });
  }

  async function handleDrop(dayKey: string) {
    const job = scheduled.find((j) => j.id === dragJobId);
    setDragJobId(null);
    if (!job?.scheduledFor || savingId) return;
    if (localDayKey(new Date(job.scheduledFor)) === dayKey) return;
    const nextIso = retargetSchedule(job.scheduledFor, dayKey, new Date(), SCHEDULE_BUFFER_MS);
    if (!nextIso) {
      toast.error("That time has already passed — pick a future day, or edit the post to change its time.");
      return;
    }
    setSavingId(job.id);
    try {
      const response = await fetch(`/api/posts/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledFor: nextIso }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(data?.error ?? "Couldn't reschedule this post.");
        return;
      }
      onRescheduled(job.id, nextIso);
      toast.success("Post rescheduled.");
    } catch {
      toast.error("Couldn't reschedule this post.");
    } finally {
      setSavingId(null);
    }
  }

  const monthLabel = MONTH_FORMAT.format(new Date(monthCursor.year, monthCursor.monthIndex, 1));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{monthLabel}</h2>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
            <ChevronLeft aria-hidden className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const now = new Date();
              setMonthCursor({ year: now.getFullYear(), monthIndex: now.getMonth() });
            }}
          >
            Today
          </Button>
          <Button size="sm" variant="outline" aria-label="Next month" onClick={() => shiftMonth(1)}>
            <ChevronRight aria-hidden className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {draftCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {draftCount} draft{draftCount === 1 ? "" : "s"} without a date — see List view.
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          <div className="grid grid-cols-7 border-b border-border pb-1">
            {WEEKDAY_LABELS.map((label) => (
              <div key={label} className="px-1 text-center text-xs font-medium text-muted-foreground">
                {label}
              </div>
            ))}
          </div>
          {weeks.map((week, i) => (
            <div key={i} className="grid grid-cols-7">
              {week.map((day) => {
                const dayJobs = byDay.get(day.key) ?? [];
                return (
                  <div
                    key={day.key}
                    onDragOver={(e) => {
                      if (dragJobId) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      void handleDrop(day.key);
                    }}
                    className={cn(
                      "min-h-24 border-b border-r border-border p-1 align-top first:border-l",
                      !day.inMonth && "bg-muted/40",
                    )}
                  >
                    <div
                      className={cn(
                        "mb-1 text-right text-xs",
                        day.key === todayKey
                          ? "font-semibold text-primary"
                          : day.inMonth
                            ? "text-foreground"
                            : "text-muted-foreground",
                      )}
                    >
                      {day.dayOfMonth}
                    </div>
                    <div className="flex flex-col gap-1">
                      {dayJobs.map((job) => (
                        <button
                          key={job.id}
                          type="button"
                          draggable
                          onDragStart={() => setDragJobId(job.id)}
                          onDragEnd={() => setDragJobId(null)}
                          onClick={() => onEdit(job)}
                          disabled={savingId === job.id}
                          title={job.caption ?? undefined}
                          className={cn(
                            "w-full cursor-grab truncate rounded-[calc(var(--radius)-0.125rem)] border border-primary/40 bg-primary/10 px-1.5 py-1 text-left text-xs text-foreground outline-none transition-colors hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                            savingId === job.id && "cursor-wait",
                          )}
                        >
                          <span className="font-medium">
                            {job.scheduledFor ? TIME_FORMAT.format(new Date(job.scheduledFor)) : ""}
                          </span>{" "}
                          {job.publish?.targetPlatforms?.length
                            ? job.publish.targetPlatforms.map(platformLabel).join(", ")
                            : (job.caption ?? "Scheduled post")}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Drag a post to another day to reschedule it (keeps its time — {localTimeZoneLabel()}).
        Click a post to edit the exact time.
      </p>
    </div>
  );
}
```

NOTE for implementer: check `PostJobDTO`'s actual field names first (`caption` vs `baseCaption`, `publish.targetPlatforms` — open `app/src/lib/postsDto.ts`) and adjust the chip label line to the real shape; the QueueCard component (same file as QueueView) already renders these fields — mirror it.

- [ ] **Step 2: Wire the toggle into `queue-view.tsx`**
  1. Add `import { QueueCalendar } from "./queue-calendar";` and `const [view, setView] = useState<"list" | "calendar">("list");`.
  2. Add an `onRescheduled` updater next to `removeJob`:

```typescript
  const applyReschedule = useCallback((id: string, scheduledFor: string) => {
    setJobs((prev) =>
      prev
        ? sortQueue(prev.map((j) => (j.id === id ? { ...j, scheduledFor } : j)))
        : prev,
    );
  }, []);
```

  3. In the header area of the rendered page (next to the existing "New post" button — find the `buttonVariants({ variant: "primary"` link near line 411), add a two-button toggle styled like the composer's "When to publish" group (`role="group"`, `aria-pressed`, same classes — copy from `create-post-form.tsx` lines 1056–1080), labels `List` and `Calendar`.
  4. Render `view === "calendar" ? <QueueCalendar jobs={jobs ?? []} onEdit={setEditTarget} onRescheduled={applyReschedule} /> : <existing list markup>` — wrap the EXISTING card list + Load more block in the conditional; loading/error/empty states stay OUTSIDE the conditional (shared by both views). In calendar view, keep the Load more button visible under the calendar when `nextCursor` is non-null (older pages may hold scheduled posts too).

- [ ] **Step 3: Full verification** — `npm test`, `npx tsc --noEmit`, `npx eslint .` in `app/` — all clean.

- [ ] **Step 4: Local visual check** — `npx playwright test e2e/` may not cover the queue; instead run the existing suites to confirm no regression, and rely on Step 6's prod verification for the visual pass (throwaway member account, screenshots of calendar view, a real drag via Playwright `dragTo`).

- [ ] **Step 5: Commit + PR** — `feat(queue): month calendar view with drag-to-reschedule`, push, CI green, squash-merge.

- [ ] **Step 6: Prod verification (established probe technique — see memory `publish-path-verification-2026-07-26`)**
  1. Throwaway member user via register + DB (verify email, add to a workspace or use own workspace: scheduling needs NO connection for drafts, but SCHEDULED posts need... none either — deferred jobs need no connection at create time; use the throwaway's own workspace).
  2. Playwright: schedule a post ~3 days out; switch Queue to Calendar; assert the chip renders on the right day (screenshot light+dark); `chip.dragTo(targetDayCell)` one week later; assert toast "Post rescheduled." and chip moved; reload → persisted (PATCH really landed).
  3. Verify past-day drop shows the rejection toast and does NOT move the chip.
  4. Clean up: delete throwaway user (cascade) + blob.

---

## Self-Review (done at planning time)

- Coverage: month grid, grouping, drag rule → Task 1; component, toggle, integration, prod proof → Task 2.
- Placeholders: none — full code inline; the one deliberate "check the real DTO shape" note tells the implementer exactly where to look and what to mirror.
- Type consistency: `retargetSchedule(originalIso, dayKey, now, bufferMs)` identical in tests/impl/component; `onRescheduled(id, scheduledFor)` matches `applyReschedule`.
