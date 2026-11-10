import { qrSvg } from "@/lib/qrSvg";

import { PrintButton } from "./print-button";

/**
 * Only the card is printed: the app's sidebar and top bar (AppShell) are hidden
 * on paper, so the page needs no layout of its own.
 */
const PRINT_CSS = `@media print {
  body * { visibility: hidden !important; }
  .review-print-card, .review-print-card * { visibility: visible !important; }
  .review-print-card { position: absolute; left: 0; top: 0; width: 100%; border: none !important; }
  .review-print-card .no-print { display: none !important; }
}`;

/** The printable "review us" card (2026-11-10): name, one line and a large QR code. */
export function PrintCard({ businessName, url }: { businessName: string; url: string | null }) {
  if (!url) {
    return (
      <div className="mx-auto max-w-xl px-4 py-8">
        <p className="text-sm text-muted-foreground">
          There is no review link to print yet. Open the Reviews page to get your Google review link, then
          print the card from there.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <style>{PRINT_CSS}</style>
      <div className="review-print-card flex flex-col items-center gap-6 rounded-[var(--radius)] border border-border bg-white p-10 text-center text-black">
        <h1 className="text-3xl font-bold">{businessName}</h1>
        <p className="text-xl">Scan to review us on Google</p>
        <div
          className="w-full max-w-sm"
          // Built by qrSvg from the link: numbers and fixed markup only.
          dangerouslySetInnerHTML={{ __html: qrSvg(url) }}
        />
        <div className="no-print">
          <PrintButton />
        </div>
      </div>
    </div>
  );
}
