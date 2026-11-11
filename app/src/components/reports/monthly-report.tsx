import Link from "next/link";

import { MediaThumb } from "@/components/media-thumb";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { describeListingChange, type ListingMetricTotals } from "@/lib/listingMetrics";
import {
  REPORT_NUMBER_KEYS,
  REPORT_NUMBER_LABELS,
  REPORT_UTC_NOTE,
  failedLine,
  monthLabel,
  numberLine,
  showingLine,
  type MonthlyReport,
  type ReportListing,
  type ReportPost,
} from "@/lib/monthlyReport";
import { formatNumber } from "@/lib/formatNumber";
import { countWord } from "@/lib/plural";

/**
 * The monthly report (18a), as both pages show it: the workspace's /reports and
 * the client's /v/[token]/report. It renders the report object and nothing
 * else, so the two pages cannot differ in what they show. No hooks: it renders
 * on the server for the workspace and in the browser for the client.
 *
 * Dates are written in UTC, the same calendar the month is counted in.
 */

/**
 * Print: the app's sidebar, top bar and drawer (aside, header, nav) and every
 * control go; the shell's sidebar gutter closes; dark text on white whatever
 * the theme. The variables are set on every selector globals.css themes with
 * (its system dark mode rule `:root:not(.light)` is more specific than
 * `:root`) and marked !important, and every text in the report is forced to
 * black, since browsers do not print backgrounds. A post never splits across pages; a link's address is printed
 * beside its label. Set as a string: React would escape characters in a
 * <style> child.
 */
const PRINT_CSS = `
@media print {
  @page { margin: 12mm; }
  :root, :root:not(.light), :root.dark, :root.light {
    color-scheme: light !important;
    --background: #ffffff !important;
    --foreground: #000000 !important;
    --card: #ffffff !important;
    --card-foreground: #000000 !important;
    --muted: #ffffff !important;
    --muted-foreground: #334155 !important;
    --border: #94a3b8 !important;
    --primary: #000000 !important;
  }
  html, body { background: #ffffff !important; color: #000000 !important; }
  [data-report], [data-report] * {
    color: #000000 !important;
    background: transparent !important;
    border-color: #94a3b8 !important;
  }
  aside, header, nav, [data-report-noprint] { display: none !important; }
  [class~="md:pl-64"] { padding-left: 0 !important; }
  [data-report-post], [data-report-block] { break-inside: avoid; page-break-inside: avoid; }
  [data-report-url] { display: inline !important; }
  [data-report] a { color: #000000 !important; }
  [data-report] img, [data-report] video { width: 2.5rem !important; height: 2.5rem !important; }
  [data-report] img[data-report-logo] { width: auto !important; height: auto !important; max-height: 48px !important; }
}
`;

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function PostPicture({ post }: { post: ReportPost }) {
  // A post without a file (mediaCount 0) never had a picture to remove.
  if (post.mediaCount === 0) return null;
  if (!post.media) {
    return (
      <div
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius)] border border-border bg-muted text-center text-[10px] leading-tight text-muted-foreground"
        role="img"
        aria-label="File removed"
      >
        File removed
      </div>
    );
  }
  return <MediaThumb media={post.media} />;
}

function PostRow({ post }: { post: ReportPost }) {
  return (
    <li data-report-post className="rounded-[var(--radius)] border border-border bg-card p-3 text-card-foreground">
      <div className="flex gap-3">
        <PostPicture post={post} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            <time dateTime={post.publishedAt}>{formatDay(post.publishedAt)}</time>
            {post.mediaCount > 1 ? (
              <span className="ml-2 font-normal text-muted-foreground">{`${formatNumber(post.mediaCount)} photos`}</span>
            ) : null}
          </p>
          {post.caption ? <p className="mt-1 whitespace-pre-wrap break-words text-sm">{post.caption}</p> : null}
        </div>
      </div>
      <ul className="mt-3 space-y-2">
        {post.platforms.map((p) => {
          const numbers = REPORT_NUMBER_KEYS.filter((key) => typeof p.numbers[key] === "number");
          return (
            <li key={p.platform} className="text-sm">
              <span className="font-medium">{p.platform}</span>
              {p.story ? (
                <span className="ml-2 rounded-full border border-border px-1.5 text-xs text-muted-foreground">Story</span>
              ) : null}
              {p.url ? (
                <>
                  {" "}
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                    View post
                  </a>
                  <span data-report-url className="ml-1 hidden break-all text-xs">
                    {p.url}
                  </span>
                </>
              ) : null}
              {numbers.length > 0 ? (
                <span className="mt-0.5 block text-muted-foreground">
                  {numbers.map((key) => `${REPORT_NUMBER_LABELS[key]} ${formatNumber(p.numbers[key] ?? 0)}`).join(" · ")}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

const LISTING_LINES: { key: keyof ListingMetricTotals; label: string }[] = [
  { key: "views", label: "Views (Search and Maps)" },
  { key: "calls", label: "Calls" },
  { key: "directionRequests", label: "Direction requests" },
  { key: "websiteClicks", label: "Website clicks" },
];

function ListingSection({ listing }: { listing: ReportListing }) {
  return (
    <section data-report-block className="space-y-2">
      <h2 className="text-lg font-semibold">Google listing</h2>
      <p className="text-sm text-muted-foreground">
        {`Numbers for ${formatNumber(listing.daysCovered)} of ${formatNumber(listing.daysCounted)} ${countWord(listing.daysCounted, "day", "days")}${listing.partial ? " so far" : ""}.`}
        {listing.partial ? " This month is not over yet, so these numbers are partial." : null}
        {!listing.partial && !listing.previous ? " No comparison with the month before: one of the two months has days without numbers." : null}
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {LISTING_LINES.map(({ key, label }) => {
          const change = describeListingChange(listing.totals[key], listing.previous ? listing.previous[key] : null);
          return (
            <li key={key} className="rounded-[var(--radius)] border border-border p-3 text-sm">
              <span className="block text-muted-foreground">{label}</span>
              <span className="text-lg font-semibold">{formatNumber(listing.totals[key])}</span>
              {change ? <span className="ml-2 text-muted-foreground">{`${change} on the month before`}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function MonthlyReportView({
  report,
  activityHref,
}: {
  report: MonthlyReport;
  /** The workspace's own page links the failures to Activity; the client's page does not. */
  activityHref?: string;
}) {
  const showing = showingLine(report.posts.length, report.postCount);
  return (
    <article data-report className="space-y-6">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      {/* A div, not a header: the print sheet hides the app's header elements. */}
      <div data-report-block className="space-y-1">
        <div className="flex items-center gap-3">
          {report.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- the logo's public storage address, as media-thumb.tsx; alt is empty because the name is beside it
            <img data-report-logo src={report.logoUrl} alt="" className="max-h-12 w-auto max-w-[12rem] shrink-0 object-contain" />
          ) : null}
          <h1 className="min-w-0 break-words text-2xl font-bold tracking-tight">
            {`${report.workspaceName}: ${monthLabel(report.month)}`}
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {REPORT_UTC_NOTE}
          {report.inProgress ? " This month is not over yet: the report shows it so far." : null}
        </p>
      </div>

      <section data-report-block className="space-y-1 text-sm">
        <h2 className="text-lg font-semibold">Totals</h2>
        <p>{`Posts published: ${formatNumber(report.postCount)}`}</p>
        {report.totals.resultsByPlatform.length > 0 ? (
          <p>{report.totals.resultsByPlatform.map((r) => `${r.platform}: ${formatNumber(r.count)}`).join(" · ")}</p>
        ) : null}
        {report.totals.numbers.map((total) => (
          <p key={total.key}>{numberLine(total, formatNumber)}</p>
        ))}
        {showing && report.totals.numbers.length > 0 ? (
          <p className="text-muted-foreground">The numbers cover the posts listed below.</p>
        ) : null}
      </section>

      {report.listing ? <ListingSection listing={report.listing} /> : null}

      {report.failed.length > 0 ? (
        <section data-report-block className="space-y-1 text-sm">
          <h2 className="text-lg font-semibold">Did not publish</h2>
          <ul>
            {report.failed.map((entry) => (
              <li key={entry.platform}>
                {activityHref ? (
                  <Link href={activityHref} className="underline">
                    {failedLine(entry)}
                  </Link>
                ) : (
                  failedLine(entry)
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Posts</h2>
        {showing ? <p className="text-sm text-muted-foreground">{showing}</p> : null}
        {report.posts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing was published this month.</p>
        ) : (
          <ul className="space-y-3">
            {report.posts.map((post, i) => (
              <PostRow key={`${post.publishedAt}-${i}`} post={post} />
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

/**
 * The month list as a plain GET form, so it works without script on both
 * pages and the choice lands in the address (?month=YYYY-MM).
 */
export function ReportMonthPicker({ months, selected }: { months: string[]; selected: string }) {
  return (
    <form method="get" data-report-noprint className="flex flex-wrap items-end gap-2">
      <label className="text-sm">
        <span className="mb-1 block font-medium">Month</span>
        <Select name="month" defaultValue={selected} className="w-56">
          {months.map((month, i) => (
            <option key={month} value={month}>
              {i === 0 ? `${monthLabel(month)} (so far)` : monthLabel(month)}
            </option>
          ))}
        </Select>
      </label>
      <Button type="submit" variant="outline">
        Show
      </Button>
    </form>
  );
}
