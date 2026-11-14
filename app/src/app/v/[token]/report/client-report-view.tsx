"use client";

import { useCallback, useEffect, useState } from "react";

import { MonthlyReportView } from "@/components/reports/monthly-report";
import { Button } from "@/components/ui/button";
import type { MonthlyReport } from "@/lib/monthlyReport";

const LOAD_FAILED_MESSAGE = "Couldn't load the report. Check your connection and try again.";

/**
 * The client's side of the monthly report (18a): asks the limited route for
 * the month and renders the shared report. Failures are not linked anywhere:
 * the client has no Activity page.
 */
export function ClientReportView({ token, month }: { token: string; month: string }) {
  const [report, setReport] = useState<MonthlyReport | null>(null);
  // A failed load: the server's sentence, or "" for no answer (network).
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(
        `/api/review-link/${encodeURIComponent(token)}/report?month=${encodeURIComponent(month)}`,
        { cache: "no-store" },
      );
      const data = (await response.json().catch(() => null)) as (MonthlyReport & { error?: string }) | null;
      if (!response.ok || !data || typeof data.month !== "string") {
        setError(data?.error ?? "");
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

  if (error !== null) {
    return (
      <div className="space-y-3">
        <p className="text-sm">{error || LOAD_FAILED_MESSAGE}</p>
        <Button type="button" variant="outline" size="sm" data-report-noprint onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }
  if (report === null) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading the report…
      </p>
    );
  }
  return <MonthlyReportView report={report} logoPrintOnly />;
}
