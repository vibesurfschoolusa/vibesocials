import { billingFieldsSelect } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { planIncludes } from "@/lib/planFeatures";

/**
 * The workspace logo for a client page (/u, /v, /c). The workspace id comes
 * from a link that was already checked, never from the request. The logo shows
 * only where the plan includes it, as in the monthly report (P1). A failed read
 * gives no logo rather than an error page: the header has a fallback tile.
 */
export async function findClientPageLogo(workspaceId: string): Promise<string | null> {
  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { logoUrl: true, ...billingFieldsSelect() },
    });
    if (!workspace?.logoUrl) return null;
    return planIncludes(workspace, "monthlyReportEmail") ? workspace.logoUrl : null;
  } catch {
    return null;
  }
}
