import { redirect } from "next/navigation";

/**
 * The standalone connections page was consolidated into /settings. This route
 * now performs a permanent server-side redirect so any lingering links — and
 * OAuth callbacks that still target /connections — land on the settings page,
 * where connection management (and its own auth gate) lives.
 */
export default function ConnectionsPage() {
  redirect("/settings");
}
