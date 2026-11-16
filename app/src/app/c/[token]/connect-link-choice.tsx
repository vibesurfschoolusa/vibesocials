"use client";

import { useEffect, useRef, useState } from "react";
import { connectedSuccessQuery } from "@/lib/differentAccount";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { answerLostText } from "@/lib/answerLost";
import { choiceAddress, rememberChoicePlatform, rememberedChoicePlatform } from "@/lib/choicePlatform";
import { focusAfterPress } from "@/lib/focusAfter";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";

/**
 * The visitor chooses which of several accounts to connect (2026-11-11), from
 * /api/connect-link/[token]/pending/[id]. One button per account and Cancel.
 * Either way the page reloads with its outcome, so the sentence at the top
 * and the platform rows say what happened.
 */

type Candidate = { id: string; name: string; detail?: string };

export type ConnectLinkChoiceState =
  | { status: "loading" }
  | { status: "ready"; platform: string; candidates: Candidate[] }
  | { status: "gone"; message: string };

/** R28 NN2: the account may have been connected before the answer was lost. */
export const CHOICE_MAYBE_CONNECTED_MESSAGE = answerLostText("the account may have been connected", "Reload this page to see.");

const LOAD_FAILED_MESSAGE = "Couldn't load the accounts. Reload this page.";
const CHOOSE_FAILED_MESSAGE = "Couldn't connect that account. Try again.";

type ChoiceAnswer = { platform?: string; candidates?: Candidate[]; error?: string; connected?: boolean } | null;

/** What the load answered: the accounts, or why there are none (the route's sentence, else reload). */
export function loadOutcome(ok: boolean, data: ChoiceAnswer): ConnectLinkChoiceState {
  if (ok && data?.platform && data.candidates) {
    return { status: "ready", platform: data.platform, candidates: data.candidates };
  }
  return { status: "gone", message: data?.error || LOAD_FAILED_MESSAGE };
}

/**
 * A choice that didn't come back connected. `gone`: the choice ended and its
 * platform is connected, so the buttons give way to that sentence. With no
 * sentence of ours, a 2xx or 5xx may have come after the save; a 4xx did not.
 */
export function chooseFailure(status: number, data: ChoiceAnswer): { gone: boolean; message: string } {
  if (data?.error) return { gone: data.connected === true, message: data.error };
  const maySaved = status < 300 || status >= 500;
  return { gone: false, message: maySaved ? CHOICE_MAYBE_CONNECTED_MESSAGE : CHOOSE_FAILED_MESSAGE };
}

export function ConnectLinkChoice({ token, pendingId }: { token: string; pendingId: string }) {
  const router = useRouter();
  const [state, setState] = useState<ConnectLinkChoiceState>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const goneRef = useRef<HTMLParagraphElement>(null);
  const base = `/api/connect-link/${encodeURIComponent(token)}/pending/${encodeURIComponent(pendingId)}`;
  const page = `/c/${encodeURIComponent(token)}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(choiceAddress(base, rememberedChoicePlatform(pendingId)), { cache: "no-store" });
        const data = (await response.json().catch(() => null)) as ChoiceAnswer;
        if (cancelled) return;
        const outcome = loadOutcome(response.ok, data);
        if (outcome.status === "ready") rememberChoicePlatform(pendingId, outcome.platform);
        setState(outcome);
      } catch {
        if (!cancelled) setState({ status: "gone", message: LOAD_FAILED_MESSAGE });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, pendingId]);

  /** `pressed`: the account's Connect, which a gone answer removes with the whole section. */
  async function choose(candidateId: string, pressed: HTMLElement | null) {
    if (busy !== null) return;
    setBusy(candidateId);
    setError(null);
    try {
      const response = await fetchOrNoAnswer(choiceAddress(base, state.status === "ready" ? state.platform : null), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId }),
      });
      const data = (await response.json().catch(() => null)) as
        | (NonNullable<ChoiceAnswer> & { ok?: boolean; sameEnd?: boolean })
        | null;
      if (response.ok && data?.ok && data.platform) {
        // R7 review 4: with same_end when the saved LinkedIn sign-in still ends within a week.
        router.push(`${page}?${connectedSuccessQuery(data.platform, data.sameEnd === true)}`);
        return;
      }
      const failure = chooseFailure(response.status, data);
      if (failure.gone) {
        focusAfterPress(pressed, () => goneRef.current);
        setState({ status: "gone", message: failure.message });
      } else setError(failure.message);
    } catch (caught) {
      setError(isNoAnswer(caught) ? CHOICE_MAYBE_CONNECTED_MESSAGE : CHOOSE_FAILED_MESSAGE);
    }
    setBusy(null);
  }

  async function cancel(platform: string) {
    setBusy("cancel");
    try {
      await fetchOrNoAnswer(base, { method: "DELETE" });
    } catch {
      // The choice expires by itself in 15 minutes.
    }
    router.push(`${page}?error=${encodeURIComponent(`${platform}_cancelled`)}`);
  }

  return (
    <ConnectLinkChoiceView state={state} busy={busy} error={error} onChoose={choose} onCancel={cancel} goneRef={goneRef} />
  );
}

export interface ConnectLinkChoiceViewProps {
  state: ConnectLinkChoiceState;
  /** The account being connected, "cancel", or null. */
  busy: string | null;
  error: string | null;
  onChoose: (candidateId: string, pressed: HTMLElement | null) => void;
  onCancel: (platform: string) => void;
  /** The gone sentence, which takes focus when a press removed the section (R29 lead review). */
  goneRef?: React.Ref<HTMLParagraphElement>;
}

/**
 * The choice as it renders. R5-pages L9: what a press or the load answers comes
 * later, so it is announced (role="alert"), as is the loading line (status).
 */
export function ConnectLinkChoiceView({ state, busy, error, onChoose, onCancel, goneRef }: ConnectLinkChoiceViewProps) {
  if (state.status === "loading") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading the accounts…
      </p>
    );
  }
  if (state.status === "gone") {
    return (
      <p ref={goneRef} role="alert" tabIndex={-1} className="text-sm outline-none">
        {state.message}
      </p>
    );
  }

  return (
    <section className="rounded-[var(--radius)] border p-4">
      <h2 className="text-base font-semibold">Choose the account to connect</h2>
      <ul className="mt-3 space-y-2">
        {state.candidates.map((candidate) => (
          <li key={candidate.id} className="flex items-center justify-between gap-3">
            <span className="min-w-0 break-words">
              {candidate.name}
              {candidate.detail ? (
                <span className="block text-sm text-muted-foreground">{candidate.detail}</span>
              ) : null}
            </span>
            <Button
              type="button"
              size="sm"
              loading={busy === candidate.id}
              aria-disabled={busy !== null || undefined}
              onClick={(event) => onChoose(candidate.id, event.currentTarget)}
            >
              Connect
            </Button>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-4"
        disabled={busy !== null}
        onClick={() => onCancel(state.platform)}
      >
        Cancel
      </Button>
    </section>
  );
}
