"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { CharacterCount, refuseOverLimit } from "@/components/ui/character-count";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { limitInputValues, limitsChangeBody, storedLimitsKey, type LimitInput } from "./limitsChange";
import { answerLostText } from "@/lib/answerLost";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";

/** Field name, label, and the default shown as the placeholder. */
export type LimitFieldView = { field: string; label: string; value: number | null; defaultLabel: string; max: number };

/** R28 NN2: the change may have been saved before the answer was lost. */
export const CHANGE_MAYBE_SAVED_MESSAGE = answerLostText("the change may have been saved", "Reload the page to see.");

const WORKSPACE_GONE_MESSAGE = "This workspace no longer exists, or you were signed out. Reload the page to see.";

async function post(url: string, body: unknown): Promise<{ ok: boolean; error?: string; changed?: boolean }> {
  try {
    const response = await fetchOrNoAnswer(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as { error?: string; changed?: boolean } | null;
    // R58 pages-a-3 L1: the routes answer a missing workspace and a signed-out
    // operator with one bare 404 (it reveals nothing), so the page words it.
    if (response.status === 404) return { ok: false, error: WORKSPACE_GONE_MESSAGE };
    if (!response.ok) return { ok: false, error: data?.error ?? "That did not work. Reload the page and try again." };
    return { ok: true, changed: data?.changed };
  } catch (caught) {
    return { ok: false, error: isNoAnswer(caught) ? CHANGE_MAYBE_SAVED_MESSAGE : "That did not work. Reload the page and try again." };
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
        <p role="status" className="text-sm text-muted-foreground empty:sr-only">{message}</p>
      </div>
    </form>
  );
}

/**
 * R46 pages-a L4: the pause route's limit and sentence (validatePauseBody in
 * the server's admin actions, which this client file can't import; a test
 * holds the two equal). The field has no maxLength, so a paste stays whole.
 */
const PAUSE_REASON_MAX = 300;
const PAUSE_REASON_TOO_LONG = `Keep the reason to ${PAUSE_REASON_MAX} characters.`;
/**
 * R56 security-billing-2 L1: validatePauseBody's rule, a run of control
 * characters (line breaks, a pasted tab) becomes one space, so the route
 * refuses nothing this field let through. A test holds the two alike.
 */
const CONTROL_CHARACTER_RUNS = /[\u0000-\u001f\u007f]+/g;

/** Pause with a reason, or resume. */
export function AdminPauseControls({ workspaceId, paused }: { workspaceId: string; paused: boolean }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  async function act(kind: "pause" | "resume") {
    if (kind === "pause" && !reason.trim()) {
      setMessage("Give a reason. The workspace's members will read it.");
      return;
    }
    if (
      kind === "pause" &&
      refuseOverLimit(
        [{ text: reason, max: PAUSE_REASON_MAX, sentence: PAUSE_REASON_TOO_LONG, field: reasonRef.current }],
        setMessage,
      )
    ) {
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
    // R41 pages L7: a change is said in the status line, as Limits and Billing say theirs.
    if (result.changed) setMessage(kind === "pause" ? "Workspace paused." : "Workspace resumed.");
    else setMessage(kind === "pause" ? "It was already paused." : "It was not paused.");
    setReason("");
    router.refresh();
  }

  // R30 PP2: one status line for both states, on the page from the first render, so a
  // message set as the page flips between paused and not is still read.
  return (
    <div className="flex flex-col gap-2">
      {paused ? (
        <>
          <p className="text-sm text-muted-foreground">
            Resuming lets it upload, create, schedule and publish again. Posts failed while it was paused stay failed
            until someone retries them. The owners are emailed.
          </p>
          <div>
            <Button type="button" onClick={() => act("resume")} loading={busy}>
              Resume workspace
            </Button>
          </div>
        </>
      ) : (
        <>
          <Label htmlFor="pause-reason">Reason (the workspace&apos;s members read this)</Label>
          <Textarea
            ref={reasonRef}
            id="pause-reason"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value.replace(CONTROL_CHARACTER_RUNS, " "))}
            disabled={busy}
            aria-describedby="pause-reason-count"
          />
          <CharacterCount
            id="pause-reason-count"
            label="Reason"
            text={reason}
            max={PAUSE_REASON_MAX}
            action="pause the workspace"
          />
          <p className="text-sm text-muted-foreground">
            Scheduled posts that come due while paused are marked failed and can be retried after you resume.
          </p>
          <div>
            <Button type="button" variant="destructive" onClick={() => act("pause")} loading={busy}>
              Pause workspace
            </Button>
          </div>
        </>
      )}
      <p role="status" className="text-sm text-muted-foreground empty:sr-only">{message}</p>
    </div>
  );
}

/**
 * 21a: "Exempt this workspace" (sets the exemption, nothing else), "End the
 * trial now" (ends any exemption, trial over at this instant) and "Set the
 * trial's end" (ends any exemption, the trial runs to the end of a UTC date
 * from tomorrow to 90 days ahead; the server judges the date in UTC). There is
 * no clearing a trial: with no plan and no trial a workspace is exempt by
 * rule, which is what the first button is for. Each is recorded.
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

  async function send(kind: "exempt" | "trial" | "end-trial", body: unknown, done: string) {
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
          variant="outline"
          onClick={() => send("exempt", {}, "Workspace exempted.")}
          loading={busy}
          disabled={exempt}
        >
          Exempt this workspace
        </Button>
        <Button type="button" variant="outline" onClick={() => send("end-trial", {}, "Trial ended.")} loading={busy}>
          End the trial now
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="trial-ends">Set the trial&apos;s end (tomorrow to 90 days ahead)</Label>
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
            onClick={() => (date ? send("trial", { trialEndsAt: date }, "Trial end saved.") : setMessage("Pick a date."))}
            loading={busy}
          >
            Set the trial&apos;s end
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The trial runs to the end of that day, UTC. Both trial controls end any exemption.
        </p>
      </div>
      <p role="status" className="text-sm text-muted-foreground empty:sr-only">{message}</p>
    </div>
  );
}
