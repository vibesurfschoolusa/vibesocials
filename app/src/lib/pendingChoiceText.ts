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
