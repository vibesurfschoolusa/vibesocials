import { describe, expect, it } from "vitest";

import { brandVoicePrompt, workspaceBrandVoicePrompt } from "./brandVoice";

/**
 * P1: the brand voice reaches the AI prompt only where the plan includes it.
 * The saved notes stay saved either way; only the prompt changes.
 */

const NOW = new Date("2026-12-10T12:00:00Z");
const LATER = new Date("2026-12-30T00:00:00Z");
const ON = { BILLING_ENABLED: "true" };
const VOICE = { brandVoice: "Sunny and short.", brandVoiceExamples: "Waves are up today\nBook a lesson" };
const BLOCK = brandVoicePrompt(VOICE.brandVoice, VOICE.brandVoiceExamples);

describe("workspaceBrandVoicePrompt", () => {
  it("leaves the brand voice out on Starter", () => {
    expect(workspaceBrandVoicePrompt({ ...VOICE, plan: "starter", planStatus: "active", currentPeriodEnd: LATER }, ON, NOW)).toBe("");
  });

  it("adds it on Growth and Pro, in a trial, for an exempt workspace, and with billing off", () => {
    expect(BLOCK).toContain("Sunny and short.");
    for (const [workspace, env] of [
      [{ ...VOICE, plan: "growth", planStatus: "active", currentPeriodEnd: LATER }, ON],
      [{ ...VOICE, plan: "pro", planStatus: "active", currentPeriodEnd: LATER }, ON],
      [{ ...VOICE, trialEndsAt: LATER }, ON],
      [{ ...VOICE, billingExempt: true, plan: "starter", planStatus: "active" }, ON],
      [{ ...VOICE }, ON],
      [{ ...VOICE, plan: "starter", planStatus: "active", currentPeriodEnd: LATER }, {}],
    ] as const) {
      expect(workspaceBrandVoicePrompt(workspace, env, NOW)).toBe(BLOCK);
    }
  });

  it("is empty with nothing saved, whatever the plan", () => {
    expect(workspaceBrandVoicePrompt({ brandVoice: null, brandVoiceExamples: null }, {}, NOW)).toBe("");
  });
});
