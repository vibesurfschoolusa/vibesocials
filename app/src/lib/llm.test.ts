import { afterEach, describe, expect, it, vi } from "vitest";

import { reasoningParams, resolveLlmConfig } from "./llm";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveLlmConfig", () => {
  it("prefers XAI_API_KEY (SpaceXAI)", () => {
    vi.stubEnv("XAI_API_KEY", "xai-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    const cfg = resolveLlmConfig();
    expect(cfg?.provider).toBe("xai");
    expect(cfg?.providerLabel).toBe("SpaceXAI");
    expect(cfg?.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg?.apiKey).toBe("xai-key");
  });

  it("falls back to OPENAI_API_KEY", () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    const cfg = resolveLlmConfig();
    expect(cfg?.provider).toBe("openai");
    expect(cfg?.providerLabel).toBe("OpenAI");
    expect(cfg?.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("returns null when no key is set", () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(resolveLlmConfig()).toBeNull();
  });
});

// 2026-11-01 scale audit (W6): grok-4.5 is a reasoning model that bills
// reasoning tokens at the default "high" effort. `reasoning_effort` is an
// xAI-only parameter — OpenAI models such as gpt-4o-mini reject it.
describe("reasoningParams", () => {
  it("asks xAI's grok-4.5 / 4.6 / 4.7 for low reasoning effort", () => {
    expect(reasoningParams("xai", "grok-4.5")).toEqual({ reasoning_effort: "low" });
    expect(reasoningParams("xai", "grok-4.6")).toEqual({ reasoning_effort: "low" });
    expect(reasoningParams("xai", "grok-4.7")).toEqual({ reasoning_effort: "low" });
    expect(reasoningParams("xai", "grok-4.5-fast")).toEqual({ reasoning_effort: "low" });
  });

  it("sends nothing for xAI models that do not take the parameter", () => {
    expect(reasoningParams("xai", "grok-4.20-0309-non-reasoning")).toEqual({});
    expect(reasoningParams("xai", "grok-4.50")).toEqual({});
    expect(reasoningParams("xai", "grok-3")).toEqual({});
  });

  it("never sends it to OpenAI, even for a model id that matches the xAI pattern", () => {
    expect(reasoningParams("openai", "gpt-4o-mini")).toEqual({});
    expect(reasoningParams("openai", "gpt-4o")).toEqual({});
    expect(reasoningParams("openai", "grok-4.5")).toEqual({});
  });
});
