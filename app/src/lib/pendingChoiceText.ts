// The failure sentence for a press on an account choice, shared by the owner's
// route (Settings) and the client's (/c). A plain module: route files may
// export only handlers.

/** Where the save stood when it failed. */
export type ChoiceFailureStage = "before_save" | "after_save";

/** The page the choice is on: Settings' dialog, or the client's /c page. */
export type ChoicePage = "settings" | "link";

/** The button the platform's Settings card shows, when it could be read. */
export interface ChoiceCardButton {
  button: string;
  label: string;
}

/**
 * R37 pages L2 / client-journey L1: nothing is saved before the chosen account
 * is, so a failure then says it wasn't connected; only a failure once the save
 * could have happened says it may have been (R31 new-customer L3).
 */
export function choiceFailedText(stage: ChoiceFailureStage, page: ChoicePage, card?: ChoiceCardButton | null): string {
  if (stage === "after_save") {
    return page === "settings"
      ? "Something went wrong on our side, so the account may have been connected. Press Cancel, then look for it in your connections before you connect again."
      : "Something went wrong on our side, so the account may have been connected. Reload this page to see.";
  }
  const reload = page === "settings" ? "Reload the page and choose it again" : "Reload this page and choose it again";
  const tail = page === "settings" && card ? `, or close this and press ${card.button} on ${card.label}` : "";
  return `That account wasn't connected: something went wrong on our side. ${reload}${tail}.`;
}

/** How long a waiting choice lasts from when it was made (PENDING_CONNECTION_TTL_MS). */
const CHOICE_LIFE_MINUTES = 15;

/** The life a choice has left at `now`, or null when its expiry is unknown. */
export function choiceLifeLeftMs(expiresAt: Date | number | null | undefined, now = Date.now()): number | null {
  if (expiresAt === null || expiresAt === undefined) return null;
  const end = typeof expiresAt === "number" ? expiresAt : expiresAt.getTime();
  return Number.isFinite(end) ? end - now : null;
}

/**
 * R42 pages-a L6: when a waiting choice ends by itself, from its own expiry,
 * rounded up to whole minutes so it is never sooner than said. Without the
 * expiry, the one thing known for sure: 15 minutes from the return from the
 * platform. `platformLabel`: that platform's name, if known.
 */
export function choiceEndsPhrase(lifeLeftMs: number | null, platformLabel: string | null): string {
  if (lifeLeftMs === null) {
    return `ends by itself within ${CHOICE_LIFE_MINUTES} minutes of when you came back from ${platformLabel ?? "signing in"}`;
  }
  if (lifeLeftMs <= 0) return "has ended by itself";
  const minutes = Math.ceil(lifeLeftMs / 60_000);
  return minutes <= 1 ? "ends by itself within a minute" : `ends by itself in ${minutes} minutes`;
}

/** A Cancel that failed on our side: the choice still waits (or ran out meanwhile), and when it ends. */
export function cancelFailedText(page: ChoicePage, lifeLeftMs: number | null, platformLabel: string | null): string {
  if (lifeLeftMs !== null && lifeLeftMs <= 0) {
    const see = page === "settings" ? "Close this to see your connections." : "Reload this page to see what is connected.";
    return `Couldn't cancel the choice just now, but it has ended by itself. ${see}`;
  }
  const ends = choiceEndsPhrase(lifeLeftMs, platformLabel);
  return page === "settings"
    ? `Couldn't cancel the choice just now. You can leave it: it ${ends}.`
    : `Couldn't cancel the choice just now. Press Cancel again, or leave this page: the choice ${ends}.`;
}

/** /c: the step after a Cancel whose answer was lost. */
export function cancelLostStep(lifeLeftMs: number | null, platformLabel: string | null): string {
  if (lifeLeftMs !== null && lifeLeftMs <= 0) return "The choice has ended by itself meanwhile. Reload this page to see.";
  return `Press Cancel again, or leave this page: the choice ${choiceEndsPhrase(lifeLeftMs, platformLabel)}.`;
}
