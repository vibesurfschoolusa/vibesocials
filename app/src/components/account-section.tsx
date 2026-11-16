"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  confirmFailureText,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { afterWorkspaceChange } from "@/lib/afterWorkspaceChange";
import { answerLostText } from "@/lib/answerLost";
import { accountDeleteLockedSentence, emailChangeLockedSentence, formatDisplayDate } from "@/lib/displayDate";
import { focusAfterPress } from "@/lib/focusAfter";
import { PAID_PLAN_ACCOUNT_DELETE_SENTENCE } from "@/lib/planCopy";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";
import { SIGN_OUT_FAILED_MESSAGE, signOutChecked } from "@/lib/signOutChecked";
import { SUPPORT_EMAIL } from "@/lib/siteInfo";
import type { AccountDeletionPreview } from "@/server/account/accountDeletion";

interface AccountSectionProps {
  email: string;
  hasPassword: boolean;
  /** Computed on the server: what deleting the account would do right now. */
  deletion: AccountDeletionPreview;
  /** S1: deleting cancels a paid plan on a workspace it deletes (app/settings/paidPlans.ts). */
  cancelsPaidPlan?: boolean;
}

const GOOGLE_ONLY = "You sign in with Google, so this account has no password to change.";
const PASSWORD_CHANGED = "Password changed. Sign in again with your new password.";
const PASSWORD_NOT_CHANGED = "Could not change your password. Try again.";

/**
 * R27 MM3 (new-customer L7): a change signs every device out on the server, so
 * when the answer is lost the password may have changed. Never "nothing changed".
 */
export const PASSWORD_MAYBE_CHANGED_MESSAGE = answerLostText(
  "your password may have changed",
  "Reload this page: if it asks you to sign in, use your new password.",
);

/** What a refused or unreadable change-password answer says. */
export function passwordFailureText(status: number, data: { error?: unknown } | null): string {
  if (typeof data?.error === "string" && data.error) return data.error;
  return status >= 500 ? PASSWORD_MAYBE_CHANGED_MESSAGE : PASSWORD_NOT_CHANGED;
}

/**
 * R28 NN2 (new-customer L2): deleting can't be undone, and the answer can be
 * lost after the account is gone. A retry then can't find it, so reload first.
 */
export const ACCOUNT_MAYBE_DELETED_MESSAGE = answerLostText(
  "your account may have been deleted",
  "Reload this page first, and try again only if you're still signed in.",
);

/** What a refused or unreadable delete-account answer says. */
export function accountDeleteFailureText(status: number, data: { error?: string; until?: string } | null): string {
  const readable = (typeof data?.error === "string" && data.error !== "") || typeof data?.until === "string";
  if (status >= 500 && !readable) return ACCOUNT_MAYBE_DELETED_MESSAGE;
  return accountDeleteRefusal(data, "Could not delete your account. Try again.");
}

/** R5 new-customer L4: nothing changes until the link sent to the new address is followed. */
export function emailChangeSentMessage(newEmail: string, currentEmail: string): string {
  return `If no other account uses ${newEmail}, we sent a link to it. Open that email within 24 hours to finish the change. Until then, you sign in with ${currentEmail}.`;
}

function scheduledNote(count: number): string {
  if (count === 0) return "no scheduled posts";
  return count === 1 ? "1 scheduled post will not go out" : `${count} scheduled posts will not go out`;
}

/**
 * R6-security M1: while the last change can be undone the route refuses with
 * `until`, and the sentence is written again here so its date is in the
 * viewer's time zone, not the server's.
 */
export function emailChangeRefusal(data: { error?: string; until?: string } | null, fallback: string): string {
  if (typeof data?.until === "string") return emailChangeLockedSentence(data.until);
  return data?.error ?? fallback;
}

/** R6 review: deletion waits for the undo window; the date in the viewer's zone, as above. */
export function accountDeleteRefusal(data: { error?: string; until?: string } | null, fallback: string): string {
  if (typeof data?.until === "string") return accountDeleteLockedSentence(data.until);
  return data?.error ?? fallback;
}

/** R6-pages L10: a form's error, announced to screen readers as it appears. */
export function FormError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

/** Settings → Account: sign-in email (and changing it), change password, delete account. */
export function AccountSection({ email, hasPassword, deletion, cancelsPaidPlan = false }: AccountSectionProps) {
  return (
    <Card className="flex flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">Sign-in email</h3>
        <p className="text-sm text-muted-foreground">{email}</p>
        {hasPassword ? (
          <>
            <ChangeEmailForm email={email} />
            <UndoLinkNotice />
          </>
        ) : (
          // R18 new-customer L2: the sign-in page shows a signed-in person the
          // notice, not its Forgot password link, so this links the page itself.
          <p className="text-sm text-muted-foreground">
            You sign in with Google, so your sign-in email is your Google account&apos;s address. To use another
            address,{" "}
            <Link href="/forgot-password" className="font-medium underline underline-offset-2">
              set a password
            </Link>
            , then change it here.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <h3 className="text-sm font-medium text-foreground">Password</h3>
        {hasPassword ? (
          <ChangePasswordForm />
        ) : (
          <p className="text-sm text-muted-foreground">{GOOGLE_ONLY}</p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <h3 className="text-sm font-medium text-foreground">Delete account</h3>
        <p className="text-sm text-muted-foreground">
          Removes your account and the workspaces only you use, right away.
        </p>
        <DeleteAccount hasPassword={hasPassword} deletion={deletion} cancelsPaidPlan={cancelsPaidPlan} />
      </div>
    </Card>
  );
}

/**
 * R5 new-customer L4: asks for a link to the new address
 * (api/auth/change-email). `startOpen` shows the form at once (tests).
 */
export function ChangeEmailForm({ email, startOpen = false }: { email: string; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const changeEmailRef = useRef<HTMLButtonElement>(null);
  const newEmailRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetchOrNoAnswer("/api/auth/change-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newEmail, currentPassword }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string; until?: string } | null;
        setError(emailChangeFailureText(response.status, data));
        return;
      }
      setSentTo(newEmail.trim());
      setCurrentPassword("");
    } catch (error) {
      setError(isNoAnswer(error) ? EMAIL_CHANGE_MAYBE_SENT_MESSAGE : EMAIL_CHANGE_NOT_STARTED);
    } finally {
      setBusy(false);
    }
  }

  // R30 PP2: one return, so the status line is on the page from the first
  // render in every state and only its text changes.
  return (
    <>
      {/* R30 lead review: the success Alert announces itself (components/ui/announcer.tsx). */}
      {sentTo ? (
        <Alert variant="success">
          {emailChangeSentMessage(sentTo, email)}
        </Alert>
      ) : null}
      {sentTo ? null : !open ? (
        <div>
          <Button
            ref={changeEmailRef}
            size="sm"
            variant="outline"
            onClick={(event) => {
              // R27 MM3: the button is replaced by the form; focus goes to its first field.
              focusAfterPress(event.currentTarget, () => newEmailRef.current);
              setOpen(true);
            }}
          >
            Change email
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex max-w-sm flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-email">New email</Label>
            <Input
              ref={newEmailRef}
              id="new-email"
              type="email"
              autoComplete="email"
              required
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              We send a link to this address. The change is made when you open it, and every device is signed out.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="change-email-password">Current password</Label>
            <Input
              id="change-email-password"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          {error ? <FormError message={error} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="outline" loading={busy} disabled={!newEmail || !currentPassword}>
              Send confirmation link
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={(event) => {
                focusAfterPress(event.currentTarget, () => changeEmailRef.current);
                setOpen(false);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </>
  );
}

const EMAIL_CHANGE_NOT_STARTED = "We couldn't start the change. Your email is unchanged. Please try again in a minute.";

/**
 * R27 MM3 lead follow-up: with no answer the confirmation link may already be
 * on its way, so "unchanged" could be wrong. Say where to check instead.
 */
export const EMAIL_CHANGE_MAYBE_SENT_MESSAGE = answerLostText(
  // R29 OO1 (pages L4): the request only sends a link; the sign-in email changes
  // when it is opened, so a reload would always show the old one.
  "a confirmation link may have been sent to the new address",
  "Look in that inbox for it before you ask again.",
);

/** What a refused or unreadable change-email answer says. */
export function emailChangeFailureText(status: number, data: { error?: string; until?: string } | null): string {
  const readable = (typeof data?.error === "string" && data.error !== "") || typeof data?.until === "string";
  if (status >= 500 && !readable) return EMAIL_CHANGE_MAYBE_SENT_MESSAGE;
  return emailChangeRefusal(data, EMAIL_CHANGE_NOT_STARTED);
}

/** Review 2: until when the previous address can undo the last email change. */
export function undoLinkSentence(untilIso: string): string {
  return `Your previous address can undo this change until ${formatDisplayDate(untilIso)}.`;
}

/**
 * After an email change, the old address gets a 72-hour undo link
 * (api/auth/change-email/undo); this says until when, and whom to write to
 * when that mailbox is lost. There is no switch to turn the link off: whoever
 * changed the email knows the password, so it would only help a hijacker.
 * Shows nothing while no link is live. `initialUntil` sets the first state
 * without a fetch (tests).
 */
export function UndoLinkNotice({ initialUntil }: { initialUntil?: string | null }) {
  const [until, setUntil] = useState<string | null>(initialUntil ?? null);

  useEffect(() => {
    if (initialUntil !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/auth/change-email/undo-link");
        const data = (await response.json().catch(() => null)) as { until?: string | null } | null;
        if (!cancelled && response.ok && typeof data?.until === "string") setUntil(data.until);
      } catch {
        // Nothing shown: the email that carries the link says how long it works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialUntil]);

  if (!until) return null;

  return (
    <div className="flex max-w-sm flex-col gap-1">
      <p className="text-sm text-muted-foreground">{undoLinkSentence(until)}</p>
      <p className="text-sm text-muted-foreground">Lost access to your old address? Write to {SUPPORT_EMAIL}.</p>
    </div>
  );
}

function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetchOrNoAnswer("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(passwordFailureText(response.status, data));
        return;
      }
      setChanged(true);
      // Every session is already signed out by the server; give the message a
      // moment on screen, then clear this browser's cookie too. R32
      // new-customer L2: Log in loads only once the sign-out is checked.
      window.setTimeout(() => {
        void signOutChecked().then((signedOut) => {
          // A full load, so nothing of the signed-in page stays in memory.
          if (signedOut) afterWorkspaceChange("/login");
          else setSignOutError(SIGN_OUT_FAILED_MESSAGE);
        });
      }, 2000);
    } catch (error) {
      setError(isNoAnswer(error) ? PASSWORD_MAYBE_CHANGED_MESSAGE : PASSWORD_NOT_CHANGED);
    } finally {
      setBusy(false);
    }
  }

  // R30 PP2: one return, so the status line can't be left out of a branch.
  return (
    <>
      {/* R30 lead review: the success Alert announces itself (components/ui/announcer.tsx). */}
      {changed ? (
        <Alert variant="success">
          {PASSWORD_CHANGED}
        </Alert>
      ) : null}
      {signOutError ? <Alert variant="danger">{signOutError}</Alert> : null}
      {changed ? null : (
        <form onSubmit={handleSubmit} className="flex max-w-sm flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">At least 8 characters.</p>
          </div>
          {error ? <FormError message={error} /> : null}
          <div>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              loading={busy}
              disabled={!currentPassword || !newPassword}
            >
              Change password
            </Button>
          </div>
        </form>
      )}
    </>
  );
}

function DeleteAccount({
  hasPassword,
  deletion,
  cancelsPaidPlan,
}: {
  hasPassword: boolean;
  deletion: AccountDeletionPreview;
  cancelsPaidPlan: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmValue, setConfirmValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setBusy(true);
    setError(null);
    // Read at the press: offline now means the request never left.
    const onLineAtPress = navigator.onLine !== false;
    try {
      const response = await fetchOrNoAnswer("/api/auth/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hasPassword ? { password: confirmValue } : { confirmEmail: confirmValue }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string; until?: string } | null;
        setError(accountDeleteFailureText(response.status, data));
        setBusy(false);
        return;
      }
    } catch (error) {
      setError(confirmFailureText(error, ACCOUNT_MAYBE_DELETED_MESSAGE, onLineAtPress));
      setBusy(false);
      return;
    }
    // Lead review (R28 NN2): the account is gone; a failing sign-out must not
    // show an error, so the page leaves as deleted whatever it does. `busy`
    // stays set while the page unloads. R32 new-customer L2: signOutChecked
    // never leaves for next-auth's own sign-out page.
    await signOutChecked();
    // A full load, as after deleting a workspace: the account and its workspaces are gone.
    afterWorkspaceChange("/");
  }

  return (
    <>
      <div>
        <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>
          Delete account
        </Button>
      </div>

      <Dialog open={open} onOpenChange={busy ? () => undefined : setOpen}>
        <DialogHeader>
          <DialogTitle>Delete your account?</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {deletion.deleteWorkspaces.length > 0 ? (
            <div>
              <p>
                These workspaces will be deleted, with their connections, media, posts and stats:
              </p>
              <ul className="mt-1 list-disc pl-5">
                {deletion.deleteWorkspaces.map((workspace, index) => (
                  <li key={`${workspace.name}-${index}`}>
                    {workspace.name} ({scheduledNote(workspace.scheduledCount)})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {deletion.leaveWorkspaces.length > 0 ? (
            <div>
              <p>
                You will leave these workspaces. What you added to them stays there and passes to
                their longest-standing owner (or member, if a workspace has no other owner):
              </p>
              <ul className="mt-1 list-disc pl-5">
                {deletion.leaveWorkspaces.map((workspace, index) => (
                  <li key={`${workspace.name}-${index}`}>{workspace.name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p>
            Your sign-in and email address are removed. Platform accounts you connected keep any
            access they granted until you remove it on each platform.
          </p>
          {cancelsPaidPlan ? <p>{PAID_PLAN_ACCOUNT_DELETE_SENTENCE}</p> : null}

          {deletion.refusal ? (
            <Alert variant="danger">{deletion.refusal}</Alert>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delete-account-confirm">
                {hasPassword ? "Type your password to confirm" : "Type your email address to confirm"}
              </Label>
              <Input
                id="delete-account-confirm"
                type={hasPassword ? "password" : "email"}
                autoComplete={hasPassword ? "current-password" : "off"}
                value={confirmValue}
                onChange={(event) => setConfirmValue(event.target.value)}
              />
            </div>
          )}
          {error ? <FormError message={error} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          {deletion.refusal ? null : (
            <Button
              variant="destructive"
              loading={busy}
              disabled={!confirmValue}
              onClick={handleDelete}
            >
              Delete account
            </Button>
          )}
        </DialogFooter>
      </Dialog>
    </>
  );
}
