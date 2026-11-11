"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { platformLabel } from "@/lib/platforms";
import type { PostJobDTO } from "@/lib/postsDto";
import { editOutcome, type JobPatch } from "@/lib/queueActions";
import {
  buildCalendarMonth,
  groupJobsByDay,
  localDayKey,
  retargetSchedule,
  startJobDrag,
  summarizeOffCalendar,
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

function chipLabel(job: PostJobDTO): string {
  if (job.caption?.trim()) return job.caption;
  const platforms = job.publish?.targetPlatforms;
  if (platforms?.length) return platforms.map(platformLabel).join(", ");
  return "Scheduled post";
}

interface QueueCalendarProps {
  jobs: PostJobDTO[];
  /** Open the existing edit dialog — also the keyboard path to reschedule. */
  onEdit: (job: PostJobDTO) => void;
  /**
   * Applied AFTER a successful PATCH so the list view stays in sync. The patch
   * carries the new time and, for a member under approval, the re-hold
   * (scheduled -> pending) the server answered with.
   */
  onRescheduled: (id: string, patch: JobPatch) => void;
}

/**
 * Month calendar of scheduled posts. Drag a chip onto a day to reschedule
 * (preserves its local time-of-day — retargetSchedule); click a chip to edit
 * the exact time in the existing dialog, which is also the keyboard-accessible
 * reschedule path. Drafts have no date and stay in the List view.
 */
/**
 * The posts the grid can't plot, for the line under it. A draft that keeps a
 * time (one the client asked to change, through the review link) is not
 * "without a date", so only drafts with no time count as such; posts awaiting
 * approval are all counted, as before.
 */
export function offCalendarSummary<
  T extends { status: string; approvalState: string; scheduledFor: string | null },
>(jobs: T[]): { awaitingApproval: number; drafts: number } {
  return summarizeOffCalendar(
    jobs.filter((j) => j.status === "scheduled" || j.approvalState === "pending" || !j.scheduledFor),
  );
}

export function QueueCalendar({ jobs, onEdit, onRescheduled }: QueueCalendarProps) {
  const toast = useToast();
  const [monthCursor, setMonthCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), monthIndex: now.getMonth() };
  });
  const [dragJobId, setDragJobId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const scheduled = useMemo(() => jobs.filter((j) => j.status === "scheduled"), [jobs]);
  // Posts the grid can't plot, split by why — a post awaiting approval often
  // HAS a proposed time, so it must not be described as "without a date".
  const offCalendar = useMemo(() => offCalendarSummary(jobs), [jobs]);
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
      toast.error(
        "That time has already passed — pick a future day, or click the post to change its time.",
      );
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
      const outcome = editOutcome(await response.json().catch(() => null));
      onRescheduled(job.id, { scheduledFor: nextIso, ...outcome.patch });
      toast.success(
        outcome.patch.approvalState === "pending"
          ? "Rescheduled — sent back for approval."
          : "Post rescheduled.",
      );
    } catch {
      toast.error("Couldn't reschedule this post.");
    } finally {
      setSavingId(null);
    }
  }

  const monthLabel = MONTH_FORMAT.format(
    new Date(monthCursor.year, monthCursor.monthIndex, 1),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{monthLabel}</h2>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            aria-label="Previous month"
            onClick={() => shiftMonth(-1)}
          >
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
          <Button
            size="sm"
            variant="outline"
            aria-label="Next month"
            onClick={() => shiftMonth(1)}
          >
            <ChevronRight aria-hidden className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {offCalendar.awaitingApproval > 0 || offCalendar.drafts > 0 ? (
        <p className="text-xs text-muted-foreground">
          {[
            offCalendar.awaitingApproval > 0
              ? `${offCalendar.awaitingApproval} awaiting approval`
              : null,
            offCalendar.drafts > 0
              ? `${offCalendar.drafts} draft${offCalendar.drafts === 1 ? "" : "s"} without a date`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}{" "}
          — see List view.
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <div className="min-w-[640px] border-t border-l border-border">
          <div className="grid grid-cols-7">
            {WEEKDAY_LABELS.map((label) => (
              <div
                key={label}
                className="border-b border-r border-border px-1 py-1 text-center text-xs font-medium text-muted-foreground"
              >
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
                      "min-h-24 border-b border-r border-border p-1 align-top",
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
                          onDragStart={(e) => {
                            startJobDrag(e.dataTransfer, job.id);
                            setDragJobId(job.id);
                          }}
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
                            {job.scheduledFor
                              ? TIME_FORMAT.format(new Date(job.scheduledFor))
                              : ""}
                          </span>{" "}
                          {chipLabel(job)}
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
        Drag a post to another day to reschedule it (keeps its time —{" "}
        {localTimeZoneLabel()}). Click a post to edit the exact time.
      </p>
    </div>
  );
}
