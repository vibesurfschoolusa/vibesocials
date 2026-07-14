/**
 * Shared LLM provider config for caption / review AI routes.
 *
 * Prefer SpaceXAI (xAI OpenAI-compatible API) via XAI_API_KEY; fall back to
 * OPENAI_API_KEY for deployments that still use OpenAI only.
 */

export type LlmConfig = {
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
      apiKey: openai,
      baseUrl: "https://api.openai.com/v1",
      textModel: process.env.OPENAI_TEXT_MODEL?.trim() || "gpt-4o-mini",
      visionModel: process.env.OPENAI_VISION_MODEL?.trim() || "gpt-4o",
      providerLabel: "OpenAI",
    };
  }

  return null;
}

export const LLM_NOT_CONFIGURED_MESSAGE =
  "AI is not configured. Set XAI_API_KEY (preferred) or OPENAI_API_KEY.";
