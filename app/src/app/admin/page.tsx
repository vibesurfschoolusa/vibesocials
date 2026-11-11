import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";
import { PLAN_STATE_LABELS } from "@/lib/billing";
import { checkAdminRateLimit, getOperator } from "@/lib/operator";
import { platformLabel } from "@/lib/platforms";
import { formatStorageGb } from "@/lib/usageLimits";
import { ADMIN_SEARCH_MAX_LENGTH, listAdminWorkspaces, type AdminWorkspaceRow } from "@/server/admin/queries";

// No metadata on purpose: a page title would show on the 404 a non-operator gets.
export const dynamic = "force-dynamic";

function dateLabel(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function pageHref(search: string, page: number): string {
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (page > 0) params.set("page", String(page + 1));
  const query = params.toString();
  return query ? `/admin?${query}` : "/admin";
}

function WorkspaceRowCard({ row }: { row: AdminWorkspaceRow }) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/admin/workspaces/${encodeURIComponent(row.id)}`}
          className="truncate text-base font-semibold text-foreground underline-offset-4 hover:underline"
        >
          {row.name}
        </Link>
        {row.pausedAt ? <Badge variant="danger">Paused</Badge> : null}
      </div>
      <p className="break-all text-sm text-muted-foreground">
        {row.ownerEmails.length ? row.ownerEmails.join(", ") : "No owner"}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Created</dt>
          <dd>{dateLabel(row.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Members</dt>
          <dd>{row.memberCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Published / failed (30 days)</dt>
          <dd>
            {row.published30d} / {row.failed30d}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Storage</dt>
          <dd>{formatStorageGb(row.storageBytes)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Plan</dt>
          <dd>{PLAN_STATE_LABELS[row.planState]}</dd>
        </div>
        <div className="sm:col-span-3">
          <dt className="text-xs text-muted-foreground">Connected</dt>
          <dd>
            {row.platforms.length ? row.platforms.map(platformLabel).join(", ") : "Nothing connected"}
            {row.reconnectCount > 0 ? ` (${row.reconnectCount} need reconnecting)` : ""}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

/**
 * /admin — every customer workspace, for the operator only (src/lib/operator.ts).
 * Anyone else gets the app's 404 page, before anything is read or counted.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; page?: string | string[] }>;
}) {
  const operator = await getOperator();
  if (!operator) notFound();

  const limit = await checkAdminRateLimit(operator, "read");
  if (!limit.allowed) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 md:px-6">
        <Alert variant="warning">Too many admin page loads this hour. Wait a few minutes and reload.</Alert>
      </div>
    );
  }

  const params = await searchParams;
  const rawSearch = Array.isArray(params.q) ? params.q[0] : params.q;
  const search = (rawSearch ?? "").trim().slice(0, ADMIN_SEARCH_MAX_LENGTH);
  const rawPage = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  const page = Number.isSafeInteger(rawPage) && rawPage > 1 ? rawPage - 1 : 0;

  const { rows, hasNextPage } = await listAdminWorkspaces({ search, page, now: new Date() });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8 md:px-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Admin: workspaces</h1>
        <p className="text-sm text-muted-foreground">
          Every customer workspace, newest first. Signed in as {operator.email}.
        </p>
      </div>

      <form method="get" action="/admin" className="flex gap-2">
        <Input
          name="q"
          defaultValue={search}
          maxLength={ADMIN_SEARCH_MAX_LENGTH}
          placeholder="Workspace name or owner email"
          aria-label="Search workspaces"
        />
        <button type="submit" className={buttonVariants({ variant: "outline" })}>
          Search
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {search ? "No workspace matches that search." : "No workspaces yet."}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <WorkspaceRowCard key={row.id} row={row} />
          ))}
        </div>
      )}

      <nav className="flex justify-between text-sm" aria-label="Pages">
        {page > 0 ? <Link href={pageHref(search, page - 1)}>Newer</Link> : <span />}
        {hasNextPage ? <Link href={pageHref(search, page + 1)}>Older</Link> : <span />}
      </nav>
    </div>
  );
}
