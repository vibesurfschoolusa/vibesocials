"use client";

import { useState, type FormEvent } from "react";
import { signOut } from "next-auth/react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AccountDeletionPreview } from "@/server/account/accountDeletion";

interface AccountSectionProps {
  email: string;
  hasPassword: boolean;
  /** Computed on the server: what deleting the account would do right now. */
  deletion: AccountDeletionPreview;
}

const GOOGLE_ONLY = "You sign in with Google, so this account has no password to change.";
const PASSWORD_CHANGED = "Password changed. Sign in again with your new password.";

function scheduledNote(count: number): string {
  if (count === 0) return "no scheduled posts";
  return count === 1 ? "1 scheduled post will not go out" : `${count} scheduled posts will not go out`;
}

async function errorFrom(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? fallback;
}

/** Settings → Account: sign-in email, change password, delete account. */
export function AccountSection({ email, hasPassword, deletion }: AccountSectionProps) {
  return (
    <Card className="flex flex-col gap-8 p-6">
      <div>
        <h3 className="text-sm font-medium text-foreground">Sign-in email</h3>
        <p className="mt-1 text-sm text-muted-foreground">{email}</p>
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
        <DeleteAccount hasPassword={hasPassword} deletion={deletion} />
      </div>
    </Card>
  );
}

function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!response.ok) {
        setError(await errorFrom(response, "Could not change your password. Try again."));
        return;
      }
      setChanged(true);
      // Every session is already signed out by the server; give the message a
      // moment on screen, then clear this browser's cookie too.
      window.setTimeout(() => void signOut({ callbackUrl: "/login" }), 2000);
    } catch {
      setError("Could not change your password. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (changed) {
    return <Alert variant="success">{PASSWORD_CHANGED}</Alert>;
  }

  return (
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
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
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
  );
}

function DeleteAccount({
  hasPassword,
  deletion,
}: {
  hasPassword: boolean;
  deletion: AccountDeletionPreview;
}) {
  const [open, setOpen] = useState(false);
  const [confirmValue, setConfirmValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hasPassword ? { password: confirmValue } : { confirmEmail: confirmValue }),
      });
      if (!response.ok) {
        setError(await errorFrom(response, "Could not delete your account. Try again."));
        setBusy(false);
        return;
      }
      await signOut({ callbackUrl: "/" });
    } catch {
      setError("Could not delete your account. Try again.");
      setBusy(false);
    }
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
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
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
