import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { ReviewsView } from "./reviews-view";

// Server-side auth gate (matches queue/activity): signed-out users are
// redirected before the client view ever fetches — no more raw
// "Unauthorized" error page.
export default async function ReviewsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/reviews")}`);
  }
  return <ReviewsView />;
}
