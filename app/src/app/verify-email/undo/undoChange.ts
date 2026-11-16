import { answerLostText } from "@/lib/answerLost";
import { fetchOrNoAnswer } from "@/lib/requestNoAnswer";

/**
 * What /verify-email/undo says after the person presses its button (R5
 * new-customer L4, review). The route's refusals (used, expired, the email
 * changed again, another account took the address) are plain sentences
 * already (api/auth/change-email/undo), so they are shown as they are.
 */

export type UndoView = {
  undone: boolean;
  title: string;
  message: string;
  next: { href: string; label: string };
  /** A "Try again" button: the link may not be used up, and a used one then says so. */
  offerRetry: boolean;
};

const HOME = { href: "/", label: "Go to Vibe Socials" };

export async function undoEmailChange(fetchImpl: typeof fetch, token: string): Promise<UndoView> {
  const notUndone = { undone: false, next: HOME, offerRetry: false };
  if (!token) {
    return {
      ...notUndone,
      title: "This link isn't valid",
      message: "This link is missing its code. Open the link from the email again.",
    };
  }
  let response: Response;
  try {
    response = await fetchOrNoAnswer(
      "/api/auth/change-email/undo",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) },
      fetchImpl,
    );
  } catch {
    // R28 NN2: the undo may have gone through before the answer was lost.
    return {
      ...notUndone,
      offerRetry: true,
      title: "Vibe Socials didn't answer",
      message: answerLostText("the change may have been undone", "Then press Try again to see."),
    };
  }
  const data = (await response.json().catch(() => null)) as
    | { email?: string; resetSent?: boolean; error?: string; used?: boolean; reason?: string }
    | null;
  if (response.ok) {
    // The undo cleared the password (the person who made the change knew
    // it), so the way back in is the reset link sent to this address.
    const address = data?.email ?? "your previous address";
    const resetSent = data?.resetSent === true;
    return {
      undone: true,
      offerRetry: false,
      next: resetSent
        ? { href: "/forgot-password", label: "Send another reset link" }
        : { href: "/forgot-password", label: "Reset your password" },
      title: "The change was undone",
      message: resetSent
        ? `Your email is back to ${address}. We sent a password reset link there; set a new password to sign in.`
        : `Your email is back to ${address}. We couldn't send a password reset link just now: press Reset your password below to get one, then set a new password to sign in.`,
    };
  }
  // Lead review (R28 NN2): a used link means it was already undone, so the
  // title must not say it wasn't.
  // R29 OO1 (security L1): the undo cleared the password, so the way back in is a reset.
  if (data?.used === true && data.error) {
    return {
      ...notUndone,
      next: { href: "/forgot-password", label: "Reset your password" },
      title: "This link was already used",
      message: data.error,
    };
  }
  // R29 OO1 (security L2): a link the route can't find may have been used, so
  // the title claims nothing either way; the route's sentence says what to do.
  if (data?.reason === "not_valid" && data.error) {
    return { ...notUndone, title: "This link can't be used", message: data.error };
  }
  const serverFailed = response.status >= 500;
  return {
    ...notUndone,
    offerRetry: serverFailed,
    title: serverFailed ? "Something went wrong on our side" : "The change wasn't undone",
    message:
      data?.error ??
      (serverFailed
        ? "The change may not have been undone. Press Try again in a minute to see."
        : "Nothing was changed. Open the link from the email again."),
  };
}
