import { PlanActions, type PlanOfferView } from "@/components/plan-actions";
import { Card } from "@/components/ui/card";
import { WORKSPACE_PLAN_SENTENCE } from "@/lib/planCopy";
import { GROWTH_ADDS_LINE, planIncludesLine } from "@/lib/plans";
import { formatStorageGb, OWNER_DAILY_POST_LIMIT } from "@/lib/usageLimits";
import type { WorkspaceUsage } from "@/server/usage/workspaceUsage";

import { NO_PLAN_CANCEL_LATER_LINE, type PersonalPostNote } from "./planSectionView";

export const PLAN_SWITCH_LINE = "To switch plans, use Manage plan, card and invoices.";

/** R8-new-customer L1: the viewer's own number beside the workspace's, with its reason when lower. */
function personalPostNoteText(note: PersonalPostNote): string {
  if (note.reduced === "unconfirmed") {
    return `(up to ${note.limit} a day for you across all your workspaces until you confirm your email address, then ${OWNER_DAILY_POST_LIMIT})`;
  }
  if (note.reduced === "first_day") {
    return `(up to ${note.limit} a day for you across all your workspaces on your account's first day, then ${OWNER_DAILY_POST_LIMIT} from 00:00 UTC)`;
  }
  return `(each person can send up to ${note.limit} a day across all their workspaces)`;
}

/**
 * Settings → Plan (21a): the plan state in words and the limits that apply.
 * Rendered on the server, for owners and only with billing on (the page
 * decides through planSectionLabel). 21b: with payments configured, the plan
 * buttons and the portal button (planSectionActions decides). The limits are
 * the ones the usage counts were read with, so they are what is enforced;
 * null when they could not be read.
 */
export function PlanSection({
  workspaceId,
  label,
  usage,
  notice = null,
  offers = [],
  yearlyOffers = [],
  manage = false,
  workspaceNote = false,
  growthAdds = false,
  noPlanYet = false,
  personalPostNote = null,
}: {
  /** The workspace this page was rendered for; the plan buttons send it (F3). */
  workspaceId: string;
  label: string;
  usage: WorkspaceUsage | null;
  /** 21b: the line after returning from Stripe; null otherwise. */
  notice?: string | null;
  /** 21b: one button per plan (only with payments configured). */
  offers?: PlanOfferView[];
  /** P1: one more button per plan with a yearly price. */
  yearlyOffers?: PlanOfferView[];
  /** 21b: the customer portal button. */
  manage?: boolean;
  /** S1: say that the plan covers this one workspace (billing on). */
  workspaceNote?: boolean;
  /** P1: say what Growth adds (an owner on Starter). */
  growthAdds?: boolean;
  /** R8-new-customer L4: no plan and no trial yet (planNoPlanYet). */
  noPlanYet?: boolean;
  /** R8-new-customer L1: the viewer's own number, where the per-person limit applies (planPersonalPostNote). */
  personalPostNote?: PersonalPostNote | null;
}) {
  return (
    <Card className="flex flex-col gap-3 p-6">
      <p className="text-sm font-medium text-foreground">{label}</p>
      {workspaceNote ? <p className="text-sm text-muted-foreground">{WORKSPACE_PLAN_SENTENCE}</p> : null}
      {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
      {usage ? (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">Posts per day</dt>
            <dd>
              {personalPostNote ? `${usage.postsToday.limit} ${personalPostNoteText(personalPostNote)}` : usage.postsToday.limit}
            </dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">X posts per month</dt>
            <dd>{usage.xPostsThisMonth.limit}</dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">YouTube uploads per day</dt>
            <dd>{usage.youtubeUploadsToday.limit}</dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">Media storage</dt>
            <dd>{formatStorageGb(usage.storage.limit)}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">The limits are not available right now. Reload the page to try again.</p>
      )}
      {/* P1: what each offered plan includes, as on the pricing cards. */}
      {offers.length > 0 ? (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {offers.map((offer) => (
            <li key={offer.plan}>
              {offer.name}: {planIncludesLine(offer.plan, offers.map((shown) => shown.plan))}
            </li>
          ))}
        </ul>
      ) : null}
      {growthAdds ? <p className="text-sm text-muted-foreground">{GROWTH_ADDS_LINE}</p> : null}
      {/* Q1: an owner on a plan switches in the Stripe portal, which lists every price. */}
      {growthAdds && manage ? <p className="text-sm text-muted-foreground">{PLAN_SWITCH_LINE}</p> : null}
      {noPlanYet && (offers.length > 0 || yearlyOffers.length > 0) ? (
        <p className="text-sm text-muted-foreground">{NO_PLAN_CANCEL_LATER_LINE}</p>
      ) : null}
      {offers.length > 0 || yearlyOffers.length > 0 || manage ? (
        <PlanActions workspaceId={workspaceId} offers={offers} manage={manage} yearlyOffers={yearlyOffers} />
      ) : null}
    </Card>
  );
}
