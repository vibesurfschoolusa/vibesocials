import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLlmConfig } from "./llm";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveLlmConfig", () => {
  it("prefers XAI_API_KEY (SpaceXAI)", () => {
    vi.stubEnv("XAI_API_KEY", "xai-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    const cfg = resolveLlmConfig();
    expect(cfg?.providerLabel).toBe("SpaceXAI");
    expect(cfg?.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg?.apiKey).toBe("xai-key");
  });

  it("falls back to OPENAI_API_KEY", () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    const cfg = resolveLlmConfig();
    expect(cfg?.providerLabel).toBe("OpenAI");
    expect(cfg?.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("returns null when no key is set", () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(resolveLlmConfig()).toBeNull();
  });
});
