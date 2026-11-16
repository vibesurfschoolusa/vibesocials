"use client";

import { useEffect, useRef, useState } from "react";
import { connectedSuccessQuery } from "@/lib/differentAccount";
import { useRouter } from "next/navigation";

import { AnnouncedText } from "@/components/ui/announcer";
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

const CHOICE_GONE_MESSAGE =
  "This choice has ended: it expired, or an account was already chosen. The list below shows what is connected.";

/**
 * A choice that didn't come back connected. `gone`: any 404 (R31
 * client-journey L2, as Settings): the choice ended (used, expired, or the
 * link turned off), so the buttons give way to the sentence. With no sentence
 * of ours, a 2xx or 5xx may have come after the save; a 4xx did not.
 */
export function chooseFailure(status: number, data: ChoiceAnswer): { gone: boolean; message: string } {
  if (status === 404) return { gone: true, message: data?.error || CHOICE_GONE_MESSAGE };
  if (data?.error) return { gone: false, message: data.error };
  const maySaved = status < 300 || status >= 500;
  return { gone: false, message: maySaved ? CHOICE_MAYBE_CONNECTED_MESSAGE : CHOOSE_FAILED_MESSAGE };
}

/** R30: Cancel's DELETE was refused; the choice is still waiting. */
export const CANCEL_FAILED_MESSAGE =
  "Couldn't cancel the choice. Press Cancel again, or leave this page: the choice ends by itself in 15 minutes.";
/** R30: Cancel's answer was lost, so the choice may have been cancelled already. */
export const CANCEL_LOST_MESSAGE = answerLostText(
  "the choice may already be cancelled",
  "Press Cancel again, or leave this page: the choice ends by itself in 15 minutes.",
);

/**
 * R30 client-journey L2: where Cancel goes, from the DELETE answer. Only a
 * cancel that worked says "You cancelled". A 404 means the choice is gone
 * (used, maybe by a press whose answer was lost, or expired): the page with
 * the success code when its platform is now connected, else with none, so the
 * rows say what is connected. Any other answer: the choice may still wait,
 * and the route's own sentence (as Connect shows it) or ours says so.
 */
export function cancelOutcome(
  status: number,
  data: ChoiceAnswer,
  platform: string,
  page: string,
): { go: string } | { error: string } {
  if (status >= 200 && status < 300) return { go: `${page}?error=${encodeURIComponent(`${platform}_cancelled`)}` };
  if (status === 404) return { go: data?.connected === true ? `${page}?${connectedSuccessQuery(platform, false)}` : page };
  return { error: data?.error || CANCEL_FAILED_MESSAGE };
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
        // R30 client-journey L1: the choice was used, so the rows below are out of date.
        router.refresh();
      } else setError(failure.message);
    } catch (caught) {
      setError(isNoAnswer(caught) ? CHOICE_MAYBE_CONNECTED_MESSAGE : CHOOSE_FAILED_MESSAGE);
    }
    setBusy(null);
  }

  async function cancel(platform: string) {
    setBusy("cancel");
    setError(null);
    let outcome: { go: string } | { error: string };
    try {
      const response = await fetchOrNoAnswer(choiceAddress(base, platform), { method: "DELETE" });
      const data = (await response.json().catch(() => null)) as ChoiceAnswer;
      outcome = cancelOutcome(response.status, data, platform, page);
    } catch {
      outcome = { error: CANCEL_LOST_MESSAGE };
    }
    if ("go" in outcome) {
      router.push(outcome.go);
      return;
    }
    setError(outcome.error);
    setBusy(null);
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
 * later, so it is announced (role="alert"); the loading line is read through the announcer.
 */
export function ConnectLinkChoiceView({ state, busy, error, onChoose, onCancel, goneRef }: ConnectLinkChoiceViewProps) {
  if (state.status === "loading") {
    // R30 lead review: this view comes and goes, so the line is read through the announcer.
    return <AnnouncedText className="text-sm text-muted-foreground" text="Loading the accounts…" />;
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
