"use client";

import { useEffect, useRef, useState } from "react";
import { connectedSuccessQuery } from "@/lib/differentAccount";
import { useRouter } from "next/navigation";

import { AnnouncedText } from "@/components/ui/announcer";
import { Button } from "@/components/ui/button";
import { answerLostText } from "@/lib/answerLost";
import { CONNECT_LINK_RATE_LIMIT_REASON } from "@/lib/connectLink";
import { LIMIT_UNCHECKED_MESSAGE } from "@/lib/limitUncheckedMessage";
import { choiceAddress, rememberChoicePlatform, rememberedChoicePlatform } from "@/lib/choicePlatform";
import { focusAfterPress } from "@/lib/focusAfter";
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

/**
 * R39 lead's last look: the network limit's 429, with one instruction that
 * says how, since the page offers no button: reload in N minutes (from the
 * answer's Retry-After), else later. The pending route answers only this
 * limit with a 429, so its reason is the route's own.
 */
function rateLimitedSentence(retryAfterSeconds: number | undefined): string {
  if (!retryAfterSeconds || retryAfterSeconds <= 0) return `${CONNECT_LINK_RATE_LIMIT_REASON} Reload this page later.`;
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `${CONNECT_LINK_RATE_LIMIT_REASON} Reload this page in ${minutes === 1 ? "1 minute" : `${minutes} minutes`}.`;
}

/**
 * What the load answered: the accounts; for a 404, that the choice is gone
 * (the route's sentence, else reload). R39 pages L2: any other failure leaves
 * the choice waiting. A 429 says to reload after its wait, with no button (pressing
 * within the hour can't work); the couldn't-check 503 keeps its sentence and
 * Try again; anything else says only "Press Try again", so the page gives
 * one instruction (R39 lead review).
 */
export function loadOutcome(status: number, data: ChoiceAnswer, retryAfterSeconds?: number): ConnectLinkChoiceState {
  if (status >= 200 && status < 300 && data?.platform && data.candidates) {
    return { status: "ready", platform: data.platform, candidates: data.candidates };
  }
  if (status === 404) return { status: "gone", message: data?.error || LOAD_FAILED_MESSAGE };
  if (status === 429) return { status: "failed", message: rateLimitedSentence(retryAfterSeconds), retry: false };
  if (data?.error === LIMIT_UNCHECKED_MESSAGE) return { status: "failed", message: LIMIT_UNCHECKED_MESSAGE, retry: true };
  return { status: "failed", message: LOAD_RETRY_MESSAGE, retry: true };
}

/** The wait a refused load names: the body's `retryAfterSeconds`, else the Retry-After header. */
function answerRetryAfter(response: Response, data: unknown): number | undefined {
  const fromBody = (data as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  if (typeof fromBody === "number" && fromBody > 0) return fromBody;
  const header = Number(response.headers.get("Retry-After"));
  return Number.isFinite(header) && header > 0 ? header : undefined;
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

export function ConnectLinkChoice({ token, pendingId }: { token: string; pendingId: string }) {
  const router = useRouter();
  const [state, setState] = useState<ConnectLinkChoiceState>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const goneRef = useRef<HTMLParagraphElement>(null);
  const base = `/api/connect-link/${encodeURIComponent(token)}/pending/${encodeURIComponent(pendingId)}`;
  const page = `/c/${encodeURIComponent(token)}`;

  // R39 pages L2: Try again counts up, which loads the choice again.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(choiceAddress(base, rememberedChoicePlatform(pendingId)), { cache: "no-store" });
        const data = (await response.json().catch(() => null)) as ChoiceAnswer;
        if (cancelled) return;
        const outcome = loadOutcome(response.status, data, answerRetryAfter(response, data));
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
  onCancel: (platform: string) => void;
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
        <p ref={failedRef} role="alert" className="text-sm outline-none">
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
        onClick={() => onCancel(state.platform)}
      >
        Cancel
      </Button>
    </section>
  );
}
