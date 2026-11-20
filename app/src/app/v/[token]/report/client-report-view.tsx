"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { MonthlyReportView } from "@/components/reports/monthly-report";
import { Button } from "@/components/ui/button";
import { limitReachedSentence, limitWaitSeconds } from "@/lib/clientLinkLimit";
import type { PublicMonthlyReport } from "@/lib/monthlyReport";
import { useRetryFocus } from "@/lib/useRetryFocus";

/** The load got no answer at all (the fetch threw). */
const LOAD_FAILED_MESSAGE = "Couldn't load the report. Check your connection and try again.";
/** R52 pages-a L5: an answer came but failed, with no sentence of its own (a gateway's 504 page). */
const LOAD_FAILED_SERVER_MESSAGE = "Couldn't load the report: something went wrong on our side. Try again in a minute.";

/**
 * The page's h1 until a report is shown, which carries its own (R12-pages L6).
 * page.tsx writes the same h1 for a month outside the list.
 */
function ReportPendingTitle() {
  return <h1 className="text-2xl font-bold tracking-tight">Monthly report</h1>;
}

/** The report's own h1, read when focus goes to it (the shared view draws it). */
function firstHeadingIn(element: Element | null): HTMLElement | null {
  if (!element) return null;
  if (element.tagName === "H1") return element as HTMLElement;
  for (const child of Array.from(element.children)) {
    const found = firstHeadingIn(child);
    if (found) return found;
  }
  return null;
}

/**
 * The client's side of the monthly report (18a): asks the limited route for
 * the month and renders the shared report. Failures are not linked anywhere:
 * the client has no Activity page.
 */
export function ClientReportView({ token, month }: { token: string; month: string }) {
  const [report, setReport] = useState<PublicMonthlyReport | null>(null);
  // A failed load: the server's sentence (or ours for one without), or "" for no answer (network).
  const [error, setError] = useState<string | null>(null);
  // R40 client-journey L2: the error is the network limit's, which a press can't clear.
  const [limited, setLimited] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setLimited(false);
    try {
      const response = await fetch(
        `/api/review-link/${encodeURIComponent(token)}/report?month=${encodeURIComponent(month)}`,
        { cache: "no-store" },
      );
      const data = (await response.json().catch(() => null)) as (PublicMonthlyReport & { error?: string }) | null;
      if (response.status === 429) {
        setLimited(true);
        setError(limitReachedSentence(limitWaitSeconds(response, data)));
        return;
      }
      if (!response.ok || !data || typeof data.month !== "string") {
        setError(typeof data?.error === "string" && data.error ? data.error : LOAD_FAILED_SERVER_MESSAGE);
        return;
      }
      setReport(data);
    } catch {
      setError("");
    }
  }, [token, month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-mount, as review-link-view.tsx
    void load();
  }, [load]);

  // R40 client-journey L1: Try again goes with the failure, so focus goes to
  // the loading line while the report is read, then to its heading or the new failure.
  const statusRef = useRef<HTMLParagraphElement>(null);
  const failedRef = useRef<HTMLParagraphElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  const reportHeadingRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return firstHeadingIn(reportRef.current);
      },
    }),
    [],
  );
  const retried = useRetryFocus(error === null && report === null, statusRef, [reportHeadingRef, failedRef]);
  const retry = () => {
    retried();
    void load();
  };

  // R30 PP2: the loading line is on the page from the first render (Try again
  // empties the error and so fills it again); the visible copy is hidden from
  // screen readers, which hear the region.
  return (
    <>
      <p ref={statusRef} role="status" className="sr-only">
        {error === null && report === null ? "Loading the report…" : ""}
      </p>
      {error !== null ? (
        <div className="space-y-3">
          <ReportPendingTitle />
          <p ref={failedRef} role="alert" className="text-sm outline-none">
            {error || LOAD_FAILED_MESSAGE}
          </p>
          {limited ? null : (
            <Button type="button" variant="outline" size="sm" data-report-noprint onClick={retry}>
              Try again
            </Button>
          )}
        </div>
      ) : report === null ? (
        <div className="space-y-3">
          <ReportPendingTitle />
          <p aria-hidden className="text-sm text-muted-foreground">
            Loading the report…
          </p>
        </div>
      ) : (
        // display: contents keeps the report's layout and print as they were.
        <div ref={reportRef} className="contents">
          <MonthlyReportView report={report} logoPrintOnly />
        </div>
      )}
    </>
  );
}
