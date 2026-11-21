import type { Platform } from "@prisma/client";

import { platformLabel } from "./platforms";

/**
 * R59 (publishing-flow L1, pages-a L1): the one place that words what to do
 * about a platform's connection in a post's send. The Connect versus Reconnect
 * rule was patched in place twice (#293, then R59), each time in a sentence
 * worded by hand, so every such sentence on the publish path is built here, from
 * the reason, and connectionSteps.guard.test.ts fails when a file there words
 * one itself.
 *
 * - "connect": the platform has no connection. Settings offers only Connect for it.
 * - "reconnect": the connection is flagged as needing a reconnect.
 *
 * Only an owner can take either step, so a member reads who can (R10-client-journey L1).
 * No server-only imports: the Activity card reads these too.
 */
export type ConnectionStep = "connect" | "reconnect";
export type StepReader = "owner" | "member";
export interface PlatformStep {
  platform: Platform;
  step: ConnectionStep;
}

/** The step a failed row's code asks for: prepare and the runs write CONNECTION_GONE for no connection, RECONNECT_REQUIRED for a flagged one. */
export function stepForCode(code: string | null | undefined): ConnectionStep | null {
  if (code === "CONNECTION_GONE") return "connect";
  if (code === "RECONNECT_REQUIRED") return "reconnect";
  return null;
}

/** Each platform's step, once, from a post's failed rows (a Feed and Story pair can list one twice). */
export function stepsForRows(
  rows: readonly { platform: Platform; status: string; errorCode: string | null }[],
): PlatformStep[] {
  const steps: PlatformStep[] = [];
  for (const row of rows) {
    const step = row.status === "failed" ? stepForCode(row.errorCode) : null;
    if (step && !steps.some((entry) => entry.platform === row.platform)) steps.push({ platform: row.platform, step });
  }
  return steps;
}

export type StepSentence =
  /** A failed row's stored sentence. */
  | { form: "row"; platform: Platform; step: ConnectionStep }
  /**
   * Retry refused for these platforms (#293). `unnamed` is what to say when the
   * answer listed none (the Activity card's "the failed platforms").
   */
  | { form: "retry"; platforms: readonly Platform[]; step: ConnectionStep; unnamed?: string }
  /** Retry all left this platform out. */
  | { form: "leftOut"; platform: Platform; step: ConnectionStep }
  /** The outcome email's row for a stalled platform. */
  | { form: "emailRow"; platform: Platform; step: ConnectionStep }
  /** The composer's Post now: each platform named with its own step, then Retry in Activity. */
  | { form: "composer"; steps: readonly PlatformStep[] }
  /**
   * Nothing went out and Activity lists the platforms: one verb for them all,
   * "connect or reconnect" when they differ or none is known.
   */
  | { form: "activity"; steps: readonly ConnectionStep[] }
  /** The same, in the submitter's email. */
  | { form: "activityEmail"; steps: readonly ConnectionStep[] }
  /** Nothing at all is connected in the workspace, so the step is always Connect. */
  | { form: "noneConnected"; action: "create" | "publish" };

function joinWithAnd(words: readonly string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The verb for platforms not named one by one. */
function oneVerb(steps: readonly ConnectionStep[]): string {
  const distinct = [...new Set(steps)];
  return distinct.length === 1 ? distinct[0] : "connect or reconnect";
}

/** "reconnect Instagram and YouTube, and connect X": the flagged ones first, as the composer always said. */
function namedSteps(steps: readonly PlatformStep[]): string[] {
  const labelsFor = (step: ConnectionStep) => steps.filter((entry) => entry.step === step).map((entry) => platformLabel(entry.platform));
  const reconnect = labelsFor("reconnect");
  const connect = labelsFor("connect");
  return [
    ...(reconnect.length > 0 ? [`reconnect ${joinWithAnd(reconnect)}`] : []),
    ...(connect.length > 0 ? [`connect ${joinWithAnd(connect)}`] : []),
  ];
}

/** The step as its sentence starts, for one whose "Settings" is a link (the Activity card's owner step). */
export function stepVerb(step: ConnectionStep): string {
  return capitalized(step);
}

export function connectionStepSentence(sentence: StepSentence, role: StepReader): string {
  const member = role === "member";
  switch (sentence.form) {
    case "row": {
      const label = platformLabel(sentence.platform);
      if (member) return `The workspace owner can ${sentence.step} ${label}; then retry.`;
      return sentence.step === "connect"
        ? `${label} is no longer connected. Connect it in Settings, then retry.`
        : `Reconnect ${label} in Settings, then retry.`;
    }
    case "retry": {
      const names =
        sentence.platforms.length > 0 ? joinWithAnd(sentence.platforms.map(platformLabel)) : (sentence.unnamed ?? "");
      if (member) return `The workspace owner can ${sentence.step} ${names}; then retry.`;
      return sentence.step === "connect"
        ? `Connect ${names} in Settings, then retry.`
        : `Reconnect ${names} in Settings before retrying.`;
    }
    case "leftOut": {
      const label = platformLabel(sentence.platform);
      return member
        ? `${label} left out: the workspace owner can ${sentence.step} it.`
        : `${label} left out: ${sentence.step} it in Settings.`;
    }
    case "emailRow": {
      const label = platformLabel(sentence.platform);
      return member
        ? `The workspace owner can ${sentence.step} ${label}; then retry it in Activity.`
        : `${capitalized(sentence.step)} ${label} in Settings, then retry it in Activity.`;
    }
    case "composer": {
      const steps = namedSteps(sentence.steps);
      if (member) return `The workspace owner can ${steps.join(", and ")}; then use Retry in Activity.`;
      const what = steps.length > 1 ? `${steps.join(", and ")}, in Settings` : `${steps[0] ?? ""} in Settings`;
      return `${capitalized(what)}, then use Retry in Activity.`;
    }
    case "activity": {
      const verb = oneVerb(sentence.steps);
      return member ? `Activity shows what didn't go out; the workspace owner can ${verb} it.` : `Activity shows what to ${verb}.`;
    }
    case "activityEmail": {
      const verb = oneVerb(sentence.steps);
      return member
        ? `The workspace owner can ${verb} them in Settings; Activity shows which.`
        : `${capitalized(verb)} them in Settings; Activity shows which.`;
    }
    case "noneConnected": {
      if (member) return "The workspace owner can connect a platform for this workspace.";
      return sentence.action === "create"
        ? "Connect at least one platform before creating a post."
        : "Connect at least one platform before publishing.";
    }
  }
}
