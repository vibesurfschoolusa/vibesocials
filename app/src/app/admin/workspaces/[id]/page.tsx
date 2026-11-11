import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { UsageSection } from "@/components/usage-section";
import { PLAN_STATE_LABELS } from "@/lib/billing";
import { checkAdminRateLimit, getOperator } from "@/lib/operator";
import { platformLabel } from "@/lib/platforms";
import { formatStorageGb, type WorkspaceLimits } from "@/lib/usageLimits";
import { LIMIT_FIELDS, LIMIT_MAX, type LimitField } from "@/server/admin/actions";
import { getAdminWorkspaceDetail } from "@/server/admin/queries";
import { periodEndLabel, stripeLinkFlags } from "@/server/billing/adminStripeLinks";

import { AdminBillingControls, AdminLimitsForm, AdminPauseControls, type LimitFieldView } from "./admin-controls";
import { adminBillingLines } from "./billingSentence";

// No metadata on purpose: a page title would show on the 404 a non-operator gets.
export const dynamic = "force-dynamic";

const MB = 1024 * 1024;

const LIMIT_VIEW: Record<LimitField, { label: string; key: keyof WorkspaceLimits; format: (n: number) => string }> = {
  limitPostsPerDay: { label: "Posts per day", key: "postsPerDay", format: String },
  limitXPostsPerMonth: { label: "X posts per month", key: "xPostsPerMonth", format: String },
  limitYoutubeUploadsPerDay: { label: "YouTube uploads per day", key: "youtubeUploadsPerDay", format: String },
  limitStorageMb: { label: "Storage (MB)", key: "storageBytes", format: (bytes) => String(Math.round(bytes / MB)) },
};

function dateTimeLabel(date: Date | string): string {
  return `${new Date(date).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function describeAction(action: string, detail: unknown): string {
  const d = (detail ?? {}) as { old?: Record<string, unknown>; new?: Record<string, unknown> };
  if (action === "pause") return `Paused: ${String(d.new?.pausedReason ?? "")}`;
  if (action === "resume") return "Resumed";
  if (action === "exempt") return "Exempted from billing";
  if (action === "trial") {
    const end = d.new?.trialEndsAt;
    return typeof end === "string" ? `Trial set to end ${dateTimeLabel(end)}` : "Trial changed";
  }
  if (action === "limits") {
    const changes = Object.keys(d.new ?? {}).map((field) => {
      const label = LIMIT_VIEW[field as LimitField]?.label ?? field;
      const show = (value: unknown) => (value === null || value === undefined ? "default" : String(value));
      return `${label} ${show(d.old?.[field])} → ${show(d.new?.[field])}`;
    });
    return `Limits: ${changes.join("; ")}`;
  }
  return action;
}

/**
 * /admin/workspaces/[id] — one workspace, for the operator only. Anyone else
 * gets the app's 404 page, before anything is read or counted. Shows counts and
 * account emails only: never a caption, a media file, a link token or anything
 * of a connection beyond its platform and whether it needs reconnecting.
 */
export default async function AdminWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
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

  const { id } = await params;
  if (!id || id.length > 64) notFound();
  const detail = await getAdminWorkspaceDetail(id, new Date());
  if (!detail) notFound();

  const { workspace } = detail;
  // 21b: yes or no only, never the Stripe ids.
  const stripe = await stripeLinkFlags(workspace.id);
  const billingLines = adminBillingLines(detail.billing, new Date());
  const limitFields: LimitFieldView[] = LIMIT_FIELDS.map((field) => ({
    field,
    label: LIMIT_VIEW[field].label,
    value: detail.overrides[field],
    defaultLabel: LIMIT_VIEW[field].format(detail.defaultLimits[LIMIT_VIEW[field].key]),
    max: LIMIT_MAX[field],
  }));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8 md:px-6">
      <Link href="/admin" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        All workspaces
      </Link>

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold text-foreground">{workspace.name}</h1>
        {workspace.pausedAt ? <Badge variant="danger">Paused</Badge> : null}
      </div>

      <Card className="p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <div className="col-span-2 sm:col-span-3">
            <dt className="text-xs text-muted-foreground">Owners</dt>
            <dd className="break-all">{workspace.ownerEmails.join(", ") || "No owner"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Created</dt>
            <dd>{dateTimeLabel(workspace.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Members</dt>
            <dd>{workspace.memberCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Published / failed (30 days)</dt>
            <dd>
              {workspace.published30d} / {workspace.failed30d}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Storage</dt>
            <dd>{formatStorageGb(workspace.storageBytes)}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-xs text-muted-foreground">Connected</dt>
            <dd>
              {workspace.platforms.length ? workspace.platforms.map(platformLabel).join(", ") : "Nothing connected"}
              {workspace.reconnectCount > 0 ? ` (${workspace.reconnectCount} need reconnecting)` : ""}
            </dd>
          </div>
        </dl>
      </Card>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-foreground">Limits</h2>
        <Card className="overflow-x-auto p-4">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-4 font-normal">Limit</th>
                <th className="py-1 pr-4 font-normal">In effect</th>
                <th className="py-1 font-normal">Default</th>
              </tr>
            </thead>
            <tbody>
              {LIMIT_FIELDS.map((field) => {
                const view = LIMIT_VIEW[field];
                return (
                  <tr key={field} className="border-t border-border">
                    <td className="py-1 pr-4">{view.label}</td>
                    <td className="py-1 pr-4">
                      {view.format(detail.effectiveLimits[view.key])}
                      {detail.overrides[field] !== null ? " (set here)" : ""}
                    </td>
                    <td className="py-1">{view.format(detail.defaultLimits[view.key])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        <Card className="p-4">
          <AdminLimitsForm workspaceId={workspace.id} fields={limitFields} />
        </Card>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-foreground">Usage today and this month</h2>
        <UsageSection usage={detail.usage} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-foreground">Pause</h2>
        <Card className="flex flex-col gap-3 p-4">
          {workspace.pausedAt ? (
            <p className="text-sm text-foreground">
              Paused since {dateTimeLabel(workspace.pausedAt)}. Reason: {detail.pausedReason}
            </p>
          ) : (
            <p className="text-sm text-foreground">Not paused.</p>
          )}
          <AdminPauseControls workspaceId={workspace.id} paused={Boolean(workspace.pausedAt)} />
        </Card>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-foreground">Billing</h2>
        <Card className="flex flex-col gap-3 p-4">
          <p className="text-sm text-foreground">{billingLines.enforcement}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">State</dt>
              <dd>{PLAN_STATE_LABELS[detail.billing.state]}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Exempt</dt>
              <dd>{detail.billing.billingExempt ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Plan</dt>
              <dd>{detail.billing.plan ?? "None"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Subscription status</dt>
              <dd>{detail.billing.planStatus ?? "None"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Trial ends</dt>
              <dd>{detail.billing.trialEndsAt ? dateTimeLabel(detail.billing.trialEndsAt) : "No trial"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{periodEndLabel(detail.billing.planStatus)}</dt>
              <dd>{detail.billing.currentPeriodEnd ? dateTimeLabel(detail.billing.currentPeriodEnd) : "None"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Has a Stripe customer</dt>
              <dd>{stripe.hasCustomer ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Has a Stripe subscription</dt>
              <dd>{stripe.hasSubscription ? "Yes" : "No"}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">{billingLines.state}</p>
          <AdminBillingControls
            workspaceId={workspace.id}
            exempt={detail.billing.billingExempt}
            trialEndDate={detail.billing.trialEndsAt ? detail.billing.trialEndsAt.toISOString().slice(0, 10) : null}
          />
        </Card>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-foreground">Admin actions</h2>
        <Card className="p-4">
          {detail.actions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No admin action recorded for this workspace.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border text-sm">
              {detail.actions.map((action) => (
                <li key={action.id} className="py-2 first:pt-0 last:pb-0">
                  <p className="text-foreground">{describeAction(action.action, action.detail)}</p>
                  <p className="text-xs text-muted-foreground">
                    {dateTimeLabel(action.createdAt)} by {action.operatorEmail}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
