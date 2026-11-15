import Link from "next/link";
import { MessageSquare } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SETTINGS_CONNECTIONS_HREF } from "@/lib/platforms";

/**
 * The Reviews page before a location is selected: pick one, none listed, or
 * nothing connected. R12 L1: only an owner can connect Google, and the Google
 * account (where locations are added) is the owner's, so a member reads who
 * can and gets no button into Settings. `isMember` is the page's, from the
 * server's workspace context.
 */
export function ReviewsEmptyState({
  locationsCount,
  gbpConnected,
  isMember,
}: {
  locationsCount: number;
  gbpConnected: boolean;
  isMember: boolean;
}) {
  if (locationsCount > 0) {
    return (
      <EmptyState
        icon={<MessageSquare />}
        title="Select a location"
        description="Choose a location above to view and reply to reviews"
      />
    );
  }
  if (gbpConnected) {
    return (
      <EmptyState
        icon={<MessageSquare />}
        title="No locations found"
        description={
          isMember
            ? "The connected Google Business Profile doesn't have any locations yet. The workspace owner can add one in Google Business Profile."
            : "Your connected Google Business Profile doesn't have any locations yet. Add one in Google Business Profile, then refresh this page."
        }
      />
    );
  }
  if (isMember) {
    return (
      <EmptyState
        icon={<MessageSquare />}
        title="Google Business Profile is not connected"
        description="Reviews come from this workspace's Google Business Profile listing. The workspace owner can connect Google Business Profile."
      />
    );
  }
  return (
    <EmptyState
      icon={<MessageSquare />}
      title="Connect Google Business Profile"
      description="Reviews come from your Google Business Profile listing. Connect it in Settings to see and reply to reviews here."
      action={
        <Link href={SETTINGS_CONNECTIONS_HREF} className={buttonVariants({ variant: "primary" })}>
          Go to connections
        </Link>
      }
    />
  );
}
