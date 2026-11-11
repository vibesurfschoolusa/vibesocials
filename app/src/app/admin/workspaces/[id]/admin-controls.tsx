"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { limitInputValues, limitsChangeBody, storedLimitsKey, type LimitInput } from "./limitsChange";

/** Field name, label, and the default shown as the placeholder. */
export type LimitFieldView = { field: string; label: string; value: number | null; defaultLabel: string; max: number };

async function post(url: string, body: unknown): Promise<{ ok: boolean; error?: string; changed?: boolean }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as { error?: string; changed?: boolean } | null;
    if (!response.ok) return { ok: false, error: data?.error ?? "That did not work. Reload the page and try again." };
    return { ok: true, changed: data?.changed };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check the connection and try again." };
  }
}

/** The four overrides. Empty means "use the default"; zero blocks everything. */
export function AdminLimitsForm({ workspaceId, fields }: { workspaceId: string; fields: LimitFieldView[] }) {
  const router = useRouter();
  const inputs: LimitInput[] = fields.map((f) => ({ field: f.field, label: f.label, initial: f.value, max: f.max }));
  const [values, setValues] = useState<Record<string, string>>(() => limitInputValues(inputs));
  const [storedKey, setStoredKey] = useState(() => storedLimitsKey(inputs));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // When a refresh brings different stored values (this save, or another
  // operator's), reset the inputs to them so a stale value is never resent.
  // A render-time adjustment rather than a remount, so the "Limits saved."
  // message stays on screen.
  const currentKey = storedLimitsKey(inputs);
  if (currentKey !== storedKey) {
    setStoredKey(currentKey);
    setValues(limitInputValues(inputs));
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Only the edited fields: a stale value must not undo another operator's change.
    const change = limitsChangeBody(inputs, values);
    if (!change.ok) {
      setMessage(change.error);
      return;
    }
    const body = change.body;
    setBusy(true);
    setMessage(null);
    const result = await post(`/api/admin/workspaces/${encodeURIComponent(workspaceId)}/limits`, body);
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error ?? null);
      return;
    }
    setMessage(result.changed ? "Limits saved." : "Nothing changed.");
    router.refresh();
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.field} className="flex flex-col gap-1">
            <Label htmlFor={`limit-${f.field}`}>{f.label}</Label>
            <Input
              id={`limit-${f.field}`}
              inputMode="numeric"
              value={values[f.field]}
              placeholder={`Default: ${f.defaultLabel}`}
              onChange={(event) => setValues((current) => ({ ...current, [f.field]: event.target.value }))}
              disabled={busy}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Leave a field empty to use the default. Zero blocks it entirely.</p>
      <div className="flex items-center gap-3">
        <Button type="submit" loading={busy}>
          Save limits
        </Button>
        {message ? (
          <p role="status" className="text-sm text-muted-foreground">
            {message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** Pause with a reason, or resume. */
export function AdminPauseControls({ workspaceId, paused }: { workspaceId: string; paused: boolean }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function act(kind: "pause" | "resume") {
    if (kind === "pause" && !reason.trim()) {
      setMessage("Give a reason. The workspace's members will read it.");
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await post(
      `/api/admin/workspaces/${encodeURIComponent(workspaceId)}/${kind}`,
      kind === "pause" ? { reason } : {},
    );
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error ?? null);
      return;
    }
    if (!result.changed) setMessage(kind === "pause" ? "It was already paused." : "It was not paused.");
    setReason("");
    router.refresh();
  }

  if (paused) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          Resuming lets it upload, create, schedule and publish again. Posts failed while it was paused stay failed
          until someone retries them. The owners are emailed.
        </p>
        <div className="flex items-center gap-3">
          <Button type="button" onClick={() => act("resume")} loading={busy}>
            Resume workspace
          </Button>
          {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="pause-reason">Reason (the workspace&apos;s members read this)</Label>
      <Textarea
        id="pause-reason"
        maxLength={300}
        rows={2}
        value={reason}
        onChange={(event) => setReason(event.target.value.replace(/[\r\n]+/g, " "))}
        disabled={busy}
      />
      <p className="text-sm text-muted-foreground">
        Scheduled posts that come due while paused are marked failed and can be retried after you resume.
      </p>
      <div className="flex items-center gap-3">
        <Button type="button" variant="destructive" onClick={() => act("pause")} loading={busy}>
          Pause workspace
        </Button>
        {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
      </div>
    </div>
  );
}

/**
 * 21a: exempt the workspace from billing or end that, and set or clear its
 * trial end (a UTC date up to 90 days ahead). Each is its own change, recorded.
 */
export function AdminBillingControls({
  workspaceId,
  exempt,
  trialEndDate,
}: {
  workspaceId: string;
  exempt: boolean;
  /** The stored trial end as YYYY-MM-DD (UTC), or null. */
  trialEndDate: string | null;
}) {
  const router = useRouter();
  const [date, setDate] = useState(trialEndDate ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function send(kind: "exempt" | "trial", body: unknown, done: string) {
    setBusy(true);
    setMessage(null);
    const result = await post(`/api/admin/workspaces/${encodeURIComponent(workspaceId)}/${kind}`, body);
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error ?? null);
      return;
    }
    setMessage(result.changed ? done : "Nothing changed.");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant={exempt ? "outline" : "primary"}
          onClick={() => send("exempt", { exempt: !exempt }, exempt ? "Exemption ended." : "Workspace exempted.")}
          loading={busy}
        >
          {exempt ? "End exemption" : "Exempt from billing"}
        </Button>
        <p className="text-sm text-muted-foreground">
          {exempt
            ? "Exempt: never blocked for its plan and on the default limits."
            : "Not exempt: needs a trial or a plan once billing is on."}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="trial-ends">Free trial ends (UTC date, up to 90 days ahead)</Label>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            id="trial-ends"
            type="date"
            className="w-auto"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            disabled={busy}
          />
          <Button
            type="button"
            onClick={() =>
              date
                ? send("trial", { trialEndsAt: date }, "Trial end saved.")
                : setMessage("Pick a date, or use Clear to remove the trial.")
            }
            loading={busy}
          >
            Save trial end
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDate("");
              void send("trial", { trialEndsAt: null }, "Trial cleared.");
            }}
            disabled={busy || trialEndDate === null}
          >
            Clear
          </Button>
        </div>
      </div>
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
