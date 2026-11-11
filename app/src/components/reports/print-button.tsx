"use client";

import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";

/** The browser's own print dialog, which also saves as PDF. Left out of the printout. */
export function PrintReportButton() {
  return (
    <Button type="button" variant="outline" data-report-noprint onClick={() => window.print()}>
      <Printer aria-hidden className="h-4 w-4" />
      Print or save as PDF
    </Button>
  );
}
