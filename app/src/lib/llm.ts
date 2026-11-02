/**
 * Shared LLM provider config for caption / review AI routes.
 *
 * Prefer SpaceXAI (xAI OpenAI-compatible API) via XAI_API_KEY; fall back to
 * OPENAI_API_KEY for deployments that still use OpenAI only.
 */

export type LlmProvider = "xai" | "openai";

export type LlmConfig = {
  /**
   * Which backend `resolveLlmConfig` picked. Provider-specific request
   * parameters (see `reasoningParams`) key off this - never infer the provider
   * from `providerLabel` (display text) or `baseUrl`.
   */
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  /** Chat-completions model id for short text tasks. */
  textModel: string;
  /** Vision-capable model when the request includes an image_url. */
  visionModel: string;
  providerLabel: string;
};

/**
 * Resolve which OpenAI-compatible backend to call. Returns null when no key
 * is configured (callers map that to a 500 with a clear message).
 */
export function resolveLlmConfig(): LlmConfig | null {
  const xai = process.env.XAI_API_KEY?.trim();
  if (xai) {
    return {
      provider: "xai",
      apiKey: xai,
      baseUrl: "https://api.x.ai/v1",
      textModel: process.env.XAI_TEXT_MODEL?.trim() || "grok-4.5",
      visionModel: process.env.XAI_VISION_MODEL?.trim() || "grok-4.5",
      providerLabel: "SpaceXAI",
    };
  }

  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) {
    return {
      provider: "openai",
      apiKey: openai,
      baseUrl: "https://api.openai.com/v1",
      textModel: process.env.OPENAI_TEXT_MODEL?.trim() || "gpt-4o-mini",
      visionModel: process.env.OPENAI_VISION_MODEL?.trim() || "gpt-4o",
      providerLabel: "OpenAI",
    };
  }

  return null;
}

/**
 * xAI reasoning models that accept `reasoning_effort` ("low" | "medium" |
 * "high", default "high"): grok-4.5, grok-4.6, grok-4.7 and dated/suffixed ids
 * such as `grok-4.5-fast`. Deliberately a narrow allowlist - the
 * `...-non-reasoning` variants and older models do not take the parameter.
 */
const XAI_REASONING_EFFORT_MODEL = /^grok-4\.(5|6|7)(\b|-)/;

/**
 * 2026-11-01 scale audit (W6): grok-4.5 is a reasoning model whose effort
 * defaults to "high" and whose reasoning tokens are billed. These are
 * one-line caption / reply tasks, so ask for "low". Spread the result into the
 * chat-completions body, passing the model id that is actually being sent.
 *
 * `reasoning_effort` is xAI-only: OpenAI models such as gpt-4o-mini reject an
 * unknown parameter with a 400, so this returns `{}` for every other provider.
 */
export function reasoningParams(
  provider: string,
  model: string,
): { reasoning_effort?: "low" } {
  if (provider === "xai" && XAI_REASONING_EFFORT_MODEL.test(model)) {
    return { reasoning_effort: "low" };
  }
  return {};
}

export const LLM_NOT_CONFIGURED_MESSAGE =
  "AI is not configured. Set XAI_API_KEY (preferred) or OPENAI_API_KEY.";
