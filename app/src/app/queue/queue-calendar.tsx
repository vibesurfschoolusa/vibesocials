"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { useAnnounceOnShow } from "@/components/ui/announcer";
import { Button } from "@/components/ui/button";
import { CONFIRM_NOTHING_SENT_MESSAGE } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { answerLostText } from "@/lib/answerLost";
import { cn } from "@/lib/cn";
import { platformLabel } from "@/lib/platforms";
import { labelName } from "@/lib/queueLabelName";
import { editOutcome, postActionRefusal, sendActionRequest, type JobPatch } from "@/lib/queueActions";
import {
  buildCalendarMonth,
  groupJobsByDay,
  localDayKey,
  retargetSchedule,
  startJobDrag,
  summarizeOffCalendar,
} from "@/lib/queueCalendar";
import { SCHEDULE_BUFFER_MS, SCHEDULED_TIME_TOO_SOON_MESSAGE, localTimeZoneLabel } from "@/lib/scheduling";
import { cardRequest, withPairNote, type QueueCard as QueueCardPost } from "./pairActions";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTH_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

// R43 pages-a L5: the day a chip is on, for its name ("Fri, Nov 20"); the
// grid's day number isn't tied to the chip for a screen reader.
const CHIP_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

// R46 pages-a L3: the caption's start by the Queue's 40-character rule; the
// chip's title keeps the whole caption.
function chipLabel(job: QueueCardPost): string {
  if (job.caption?.trim()) return labelName(job.caption);
  const platforms = job.publish?.targetPlatforms;
  if (platforms?.length) return platforms.map(platformLabel).join(", ");
  return "Scheduled post";
}

interface QueueCalendarProps {
  /** The Queue's cards: a Feed and Story pair is one chip (R3-client-journey M1). */
  jobs: QueueCardPost[];
  /** Switch the Queue to its list view (the same as its List toggle). */
  onShowList: () => void;
  /** Open the existing edit dialog — also the keyboard path to reschedule. */
  onEdit: (job: QueueCardPost) => void;
  /**
   * Applied AFTER a successful PATCH so the list view stays in sync. The patch
   * carries the new time and, for a member under approval, the re-hold
   * (scheduled -> pending) the server answered with; `answer` says whether a
   * pair's other half moved too.
   */
  onRescheduled: (card: QueueCardPost, patch: JobPatch, answer: unknown) => void;
  /** Reads the Queue again without a spinner, after an answer that was lost. */
  onReload?: () => void;
  /** R31 pages L2: the workspace the Queue was drawn for, sent with each move. */
  workspaceId?: string | null;
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

/**
 * The line above the grid when the client asked to change posts (client review
 * link): those are drafts, which the grid does not plot. Null when there are none.
 */
export function clientChangeLine(
  jobs: { status: string; clientChangeRequestedAt?: string | null }[],
): string | null {
  const n = jobs.filter((j) => j.status === "draft" && j.clientChangeRequestedAt).length;
  if (n === 0) return null;
  return n === 1
    ? "1 post: your client asked for a change. It is in the list view."
    : `${n} posts: your client asked for a change. They are in the list view.`;
}

/**
 * R28 NN2 (publishing L3): the move may have been saved when the answer is
 * lost or a gateway answers 5xx; the Queue reads itself again.
 */
export const RESCHEDULE_MAYBE_MOVED_MESSAGE = answerLostText(
  "the post may have moved",
  "We're reloading the Queue: check its day before you move it again.",
);

export function QueueCalendar({
  jobs,
  onEdit,
  onRescheduled,
  onShowList,
  onReload = () => {},
  workspaceId = null,
}: QueueCalendarProps) {
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
  const clientChanges = useMemo(() => clientChangeLine(jobs), [jobs]);
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
      // R49 pages-a L3: the one too-soon sentence, by the same buffer as the
      // edit dialog, Create, Add many and PATCH.
      toast.error(SCHEDULED_TIME_TOO_SOON_MESSAGE);
      return;
    }
    setSavingId(job.id);
    try {
      // A Feed and Story chip moves both halves (R3-client-journey M1).
      const answer = await sendActionRequest(`/api/posts/${job.id}`, cardRequest(job, "PATCH", workspaceId, { scheduledFor: nextIso }));
      if (answer.kind === "not_sent") {
        toast.error(CONFIRM_NOTHING_SENT_MESSAGE);
        return;
      }
      if (answer.kind === "no_answer") {
        onReload();
        toast.error(RESCHEDULE_MAYBE_MOVED_MESSAGE);
        return;
      }
      const { response } = answer;
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as unknown;
        const refusal = postActionRefusal(response.status, data, "Couldn't reschedule this post.");
        toast.error(refusal.text);
        // R30 publishing L1, R31: the chip is stale (it started publishing, went out, is now a
        // draft, or is gone): re-sync, unless the page is for another workspace.
        if (refusal.reload) onReload();
        return;
      }
      const data = await response.json().catch(() => null);
      const outcome = editOutcome(data);
      onRescheduled(job, { scheduledFor: nextIso, ...outcome.patch }, data);
      toast.success(
        withPairNote(
          outcome.patch.approvalState === "pending" ? "Rescheduled — sent back for approval." : "Post rescheduled.",
          data,
        ),
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
  // R43 pages-a L5: a new month (Previous, Next, Today) is read out through
  // the page's announcer; the first one, there on load, is not.
  useAnnounceOnShow(() => monthLabel, true, false);

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

      {/* N3: an empty Queue still shows the month, with this line above it. */}
      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing scheduled this month.</p>
      ) : null}

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

      {clientChanges ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 p-2.5">
          <p className="text-sm text-foreground">{clientChanges}</p>
          <Button type="button" size="sm" variant="outline" onClick={onShowList}>
            Show the list
          </Button>
        </div>
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
                          className={cn(
                            "w-full cursor-grab truncate rounded-[calc(var(--radius)-0.125rem)] border border-primary/40 bg-primary/10 px-1.5 py-1 text-left text-xs text-foreground outline-none transition-colors hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                            savingId === job.id && "cursor-wait",
                          )}
                        >
                          {job.scheduledFor ? (
                            <span className="sr-only">{`${CHIP_DATE_FORMAT.format(new Date(job.scheduledFor))}, `}</span>
                          ) : null}
                          <span className="font-medium">
                            {job.scheduledFor
                              ? TIME_FORMAT.format(new Date(job.scheduledFor))
                              : ""}
                          </span>{" "}
                          {/* R47 pages-a L1: the whole caption shows on hover from here; on the
                              button a title is read as its description on every focus. */}
                          <span title={job.caption ?? undefined}>{chipLabel(job)}</span>
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
