"use client";

import { useEffect, useRef, useState } from "react";
import { connectedSuccessQuery } from "@/lib/differentAccount";
import { useRouter } from "next/navigation";

import { AnnouncedText } from "@/components/ui/announcer";
import { Button } from "@/components/ui/button";
import { answerLostText } from "@/lib/answerLost";
import { limitReachedSentence, limitWaitSeconds } from "@/lib/clientLinkLimit";
import { CONNECT_LINK_COOKIE_MAX_AGE_SECONDS } from "@/lib/connectLink";
import { LIMIT_UNCHECKED_MESSAGE } from "@/lib/limitUncheckedMessage";
import {
  choiceAddress,
  choiceFirstSeen,
  rememberChoicePlatform,
  rememberedChoicePlatform,
} from "@/lib/choicePlatform";
import { focusAfterPress } from "@/lib/focusAfter";
import { PLATFORM_LABELS } from "@/lib/platforms";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";
import { useRetryFocus } from "@/lib/useRetryFocus";

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
  | { status: "gone"; message: string }
  /**
   * R39 pages L2: the load failed but the choice may still wait. `retry`:
   * Try again can work now (not for a 429, which lasts its hour).
   */
  | { status: "failed"; message: string; retry: boolean };

/** R28 NN2: the account may have been connected before the answer was lost. */
export const CHOICE_MAYBE_CONNECTED_MESSAGE = answerLostText("the account may have been connected", "Reload this page to see.");

const LOAD_FAILED_MESSAGE = "Couldn't load the accounts. Reload this page.";
const LOAD_RETRY_MESSAGE = "Couldn't load the accounts. Press Try again.";
const CHOOSE_FAILED_MESSAGE = "Couldn't connect that account. Try again.";

type ChoiceAnswer = {
  platform?: string;
  candidates?: Candidate[];
  error?: string;
  connected?: boolean;
  /** A 429 names its wait here as well as in Retry-After. */
  retryAfterSeconds?: number;
} | null;

/** What the page knows of the waiting choice when the load is refused (R40 review). */
export interface LimitedChoice {
  /** The platform the tab remembered for it, if any. */
  platform?: string | null;
  /** The sign-in button that platform's row shows ("Connect" or "Reconnect"), if any. */
  button?: string | null;
  /** The life the choice has left; the full 15 minutes when unknown. */
  lifeLeftSeconds?: number;
}

/**
 * The network limit's 429 (the pending route answers only this limit with
 * one): the shared client-link instruction, with no button. R40 client-journey
 * L3 and its review: a wait the choice won't outlive names the step that works
 * after it, with the button its platform's row shows; without both, a wording
 * that names no button.
 */
function rateLimitedSentence(retryAfterSeconds: number | undefined, choice: LimitedChoice, then?: string): string {
  const label =
    choice.platform && choice.platform in PLATFORM_LABELS
      ? PLATFORM_LABELS[choice.platform as keyof typeof PLATFORM_LABELS]
      : null;
  return limitReachedSentence(retryAfterSeconds, {
    lifeSeconds: choice.lifeLeftSeconds ?? CONNECT_LINK_COOKIE_MAX_AGE_SECONDS,
    then:
      then ??
      (label && choice.button
        ? `press ${choice.button} beside ${label} again.`
        : "connect the account again from the list on this page."),
  });
}

/**
 * R41 client-journey L1: the limit counts the load, Connect and Cancel
 * together, so a press after the list loaded can get the same 429. Cancel's
 * step after a wait the choice won't outlive: it ends by itself meanwhile.
 */
export const CANCEL_AFTER_LIMIT_STEP =
  "reload this page: the choice will have ended by itself, with no account connected.";

/**
 * The view for the network limit's 429 on the load, Connect or Cancel: one
 * instruction and no button, since any press within the window fails the
 * same way. `then`: the press's own step after a wait the choice won't outlive.
 */
export function limitedOutcome(
  retryAfterSeconds: number | undefined,
  choice: LimitedChoice,
  then?: string,
): ConnectLinkChoiceState {
  return { status: "failed", message: rateLimitedSentence(retryAfterSeconds, choice, then), retry: false };
}

/** The choice for a 429, as the page knows it: platform, its row's button, life left from first seen. */
function limitedChoice(platform: string | null, firstSeen: number, buttons: Record<string, string>): LimitedChoice {
  return {
    platform,
    button: platform ? buttons[platform] : null,
    lifeLeftSeconds: CONNECT_LINK_COOKIE_MAX_AGE_SECONDS - (Date.now() - firstSeen) / 1000,
  };
}

/**
 * What the load answered: the accounts; for a 404, that the choice is gone
 * (the route's sentence, else reload). R39 pages L2: any other failure leaves
 * the choice waiting. A 429 gives the one instruction above, with no button
 * (pressing within the hour can't work); the couldn't-check 503 keeps its sentence and
 * Try again; anything else says only "Press Try again", so the page gives
 * one instruction (R39 lead review).
 */
export function loadOutcome(
  status: number,
  data: ChoiceAnswer,
  retryAfterSeconds?: number,
  choice: LimitedChoice = {},
): ConnectLinkChoiceState {
  if (status >= 200 && status < 300 && data?.platform && data.candidates) {
    return { status: "ready", platform: data.platform, candidates: data.candidates };
  }
  if (status === 404) return { status: "gone", message: data?.error || LOAD_FAILED_MESSAGE };
  if (status === 429) return limitedOutcome(retryAfterSeconds, choice);
  if (data?.error === LIMIT_UNCHECKED_MESSAGE) return { status: "failed", message: LIMIT_UNCHECKED_MESSAGE, retry: true };
  return { status: "failed", message: LOAD_RETRY_MESSAGE, retry: true };
}

const CHOICE_GONE_MESSAGE =
  "This choice has ended: it expired, or an account was already chosen. The list below shows what is connected.";

/**
 * A choice that didn't come back connected. `gone`: any 404 (R31
 * client-journey L2, as Settings): the choice ended (used, expired, or the
 * link turned off), so the buttons give way to the sentence; so does a 409
 * marked `connected` (R32 client-journey L2: the platform was connected
 * meanwhile, so nothing is left to choose). With no sentence of ours, a 2xx
 * or 5xx may have come after the save; a 4xx did not.
 */
export function chooseFailure(status: number, data: ChoiceAnswer): { gone: boolean; message: string } {
  if (status === 404 || (status === 409 && data?.connected === true)) {
    return { gone: true, message: data?.error || CHOICE_GONE_MESSAGE };
  }
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

/**
 * `buttons`: the sign-in button each platform's row shows (page.tsx), so the
 * limit's sentence names the one the client will see. Strings only.
 */
export function ConnectLinkChoice({
  token,
  pendingId,
  buttons = {},
}: {
  token: string;
  pendingId: string;
  buttons?: Record<string, string>;
}) {
  const router = useRouter();
  const [state, setState] = useState<ConnectLinkChoiceState>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const goneRef = useRef<HTMLParagraphElement>(null);
  const base = `/api/connect-link/${encodeURIComponent(token)}/pending/${encodeURIComponent(pendingId)}`;
  const page = `/c/${encodeURIComponent(token)}`;

  // R39 pages L2: Try again counts up, which loads the choice again.
  const [attempt, setAttempt] = useState(0);
  // R40 review: when this page opened, for a tab without storage (choiceFirstSeen).
  const openedAtRef = useRef<number | null>(null);
  // Read when the answer comes: a refresh hands a new object, which must not load again.
  const buttonsRef = useRef(buttons);
  useEffect(() => {
    buttonsRef.current = buttons;
  });
  useEffect(() => {
    let cancelled = false;
    openedAtRef.current ??= Date.now();
    const openedAt = openedAtRef.current;
    (async () => {
      try {
        const remembered = rememberedChoicePlatform(pendingId);
        const firstSeen = choiceFirstSeen(pendingId, openedAt) ?? openedAt;
        const response = await fetch(choiceAddress(base, remembered), { cache: "no-store" });
        const data = (await response.json().catch(() => null)) as ChoiceAnswer;
        if (cancelled) return;
        const outcome = loadOutcome(
          response.status,
          data,
          limitWaitSeconds(response, data),
          limitedChoice(remembered, firstSeen, buttonsRef.current),
        );
        if (outcome.status === "ready") rememberChoicePlatform(pendingId, outcome.platform);
        setState(outcome);
      } catch {
        if (!cancelled) setState({ status: "failed", message: LOAD_RETRY_MESSAGE, retry: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, pendingId, attempt]);

  // R39 lead review: Try again goes with the failure, so focus follows the load.
  const statusRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const failedRef = useRef<HTMLParagraphElement>(null);
  const retried = useRetryFocus(state.status === "loading", statusRef, [headingRef, failedRef, goneRef]);

  /** A press's 429: the same view as the load's, weighed against the life the choice has left. */
  function showLimited(response: Response, data: ChoiceAnswer, platform: string | null, then?: string) {
    const openedAt = openedAtRef.current ?? Date.now();
    const firstSeen = choiceFirstSeen(pendingId, openedAt) ?? openedAt;
    setState(limitedOutcome(limitWaitSeconds(response, data), limitedChoice(platform, firstSeen, buttonsRef.current), then));
  }

  function retry() {
    retried();
    setState({ status: "loading" });
    setAttempt((count) => count + 1);
  }

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
      if (response.status === 429) {
        // The section with every button goes; focus goes to the instruction.
        focusAfterPress(pressed, () => failedRef.current);
        showLimited(response, data, state.status === "ready" ? state.platform : null);
        setBusy(null);
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

  async function cancel(platform: string, pressed: HTMLElement | null) {
    setBusy("cancel");
    setError(null);
    let outcome: { go: string } | { error: string };
    try {
      const response = await fetchOrNoAnswer(choiceAddress(base, platform), { method: "DELETE" });
      const data = (await response.json().catch(() => null)) as ChoiceAnswer;
      if (response.status === 429) {
        focusAfterPress(pressed, () => failedRef.current);
        showLimited(response, data, platform, CANCEL_AFTER_LIMIT_STEP);
        setBusy(null);
        return;
      }
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
    <ConnectLinkChoiceView
      state={state}
      busy={busy}
      error={error}
      onChoose={choose}
      onCancel={cancel}
      onRetry={retry}
      goneRef={goneRef}
      statusRef={statusRef}
      headingRef={headingRef}
      failedRef={failedRef}
    />
  );
}

export interface ConnectLinkChoiceViewProps {
  state: ConnectLinkChoiceState;
  /** The account being connected, "cancel", or null. */
  busy: string | null;
  error: string | null;
  onChoose: (candidateId: string, pressed: HTMLElement | null) => void;
  onCancel: (platform: string, pressed: HTMLElement | null) => void;
  /** Loads the choice again after a failed load (R39 pages L2). */
  onRetry?: () => void;
  /** The gone sentence, which takes focus when a press removed the section (R29 lead review). */
  goneRef?: React.Ref<HTMLParagraphElement>;
  /** R39 lead review: where focus goes after Try again: the loading line, then the heading or the failure. */
  statusRef?: React.Ref<HTMLDivElement>;
  headingRef?: React.Ref<HTMLHeadingElement>;
  failedRef?: React.Ref<HTMLParagraphElement>;
}

/**
 * The choice as it renders. R5-pages L9: what a press or the load answers comes
 * later, so it is announced (role="alert"); the loading line is read through the announcer.
 */
export function ConnectLinkChoiceView({
  state,
  busy,
  error,
  onChoose,
  onCancel,
  onRetry,
  goneRef,
  statusRef,
  headingRef,
  failedRef,
}: ConnectLinkChoiceViewProps) {
  if (state.status === "loading") {
    // R30 lead review: this view comes and goes, so the line is read through the announcer.
    return (
      <div ref={statusRef} className="outline-none">
        <AnnouncedText className="text-sm text-muted-foreground" text="Loading the accounts…" />
      </div>
    );
  }
  if (state.status === "gone") {
    return (
      <p ref={goneRef} role="alert" tabIndex={-1} className="text-sm outline-none">
        {state.message}
      </p>
    );
  }
  if (state.status === "failed") {
    return (
      <div className="space-y-3">
        <p ref={failedRef} role="alert" tabIndex={-1} className="text-sm outline-none">
          {state.message}
        </p>
        {state.retry ? (
          <Button type="button" variant="outline" size="md" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <section className="rounded-[var(--radius)] border p-4">
      <h2 ref={headingRef} className="text-base font-semibold outline-none">
        Choose the account to connect
      </h2>
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
        onClick={(event) => onCancel(state.platform, event.currentTarget)}
      >
        Cancel
      </Button>
    </section>
  );
}
