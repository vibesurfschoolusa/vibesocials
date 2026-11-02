import { NextResponse } from "next/server";
import {
  AI_LIMITS,
  AI_PROVIDER_TIMEOUT_MS,
  aiInputTooLongResponse,
  aiTimeoutResponse,
  aiWorkspaceLimitResponse,
  checkWorkspaceAiQuota,
  findOverlongAiField,
  isAiTimeoutError,
} from "@/lib/aiGuards";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { LLM_NOT_CONFIGURED_MESSAGE, reasoningParams, resolveLlmConfig } from "@/lib/llm";
import { checkRateLimit } from "@/lib/rateLimit";
import { getWorkspaceContext } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * POST /api/posts/enhance-caption - Generate AI-enhanced SEO-optimized caption
 */
export async function POST(request: Request) {
  try {
    // 2026-11-01 scale audit (W6): was `getCurrentUser()`. The per-workspace
    // daily AI quota needs a workspace id, so this resolves the workspace
    // context (any member may enhance a caption - composing is member-level).
    // The per-user limit below still keys on the same user id as before.
    const context = await getWorkspaceContext();

    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await readJsonObject(request);
    if (!body) {
      return invalidJsonBodyResponse();
    }
    const { caption } = body;

    // 2026-11-01 scale audit (W6): cap the prompt text BEFORE any limiter
    // counter is spent or the provider is called.
    const overlong = findOverlongAiField([
      { field: "caption", value: caption, max: AI_LIMITS.caption },
    ]);
    if (overlong) {
      return aiInputTooLongResponse(overlong);
    }

    // Fail closed — a limiter outage must not open unlimited LLM spend.
    const rateLimit = await checkRateLimit({
      userId: context.user.id,
      route: "posts/enhance-caption",
      limit: 20,
      windowMs: 5 * 60 * 1000,
      failClosed: true,
    });

    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: "Too many requests, slow down.",
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) },
        },
      );
    }

    if (!caption || typeof caption !== "string" || !caption.trim()) {
      return NextResponse.json({ error: "Caption is required" }, { status: 400 });
    }

    const llm = resolveLlmConfig();
    if (!llm) {
      return NextResponse.json({ error: LLM_NOT_CONFIGURED_MESSAGE }, { status: 500 });
    }

    // 2026-11-01 scale audit (W6): per-workspace daily budget, spent only once
    // the request is valid and a provider is configured.
    const quota = await checkWorkspaceAiQuota(context.workspace.id);
    if (!quota.allowed) {
      return aiWorkspaceLimitResponse(quota.retryAfterSeconds);
    }

    const systemPrompt = `You are a social media expert specializing in creating engaging, SEO-optimized captions for social media posts. Your captions should be:
- Short and concise (1-2 sentences, max 150 characters)
- Use plain text only with NO hashtags (no '#' characters at all)
- Be engaging and call-to-action oriented
- SEO-friendly with keywords naturally integrated
- Suitable for platforms like Instagram, TikTok, YouTube, and X (Twitter)
- Professional yet approachable tone
- Include emojis where appropriate (but don't overdo it)

IMPORTANT: Write ONLY the enhanced caption as plain text without any hashtags. Do NOT include:
- Any meta-commentary
- Explanations or notes
- Just the caption text itself`;

    const userPrompt = `Enhance this basic caption into a short, engaging, SEO-optimized social media post:

"${caption.trim()}"

Create an enhanced version that's perfect for social media.`;

    const llmResponse = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.textModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.8,
        max_tokens: 150,
        ...reasoningParams(llm.provider, llm.textModel),
      }),
      signal: AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS),
    });

    if (!llmResponse.ok) {
      const errorData = await llmResponse.json().catch(() => ({}));
      console.error(`[Enhance Caption] ${llm.providerLabel} API error:`, errorData);
      return NextResponse.json(
        { error: "Failed to generate enhanced caption" },
        { status: 500 },
      );
    }

    const llmData = await llmResponse.json();
    let enhancedCaption = llmData.choices?.[0]?.message?.content?.trim() || "";

    enhancedCaption = enhancedCaption.replace(/#/g, "").trim();

    if (!enhancedCaption) {
      return NextResponse.json({ error: "AI generated empty caption" }, { status: 500 });
    }

    console.log("[Enhance Caption] Generated successfully", {
      originalLength: caption.length,
      enhancedLength: enhancedCaption.length,
      provider: llm.providerLabel,
    });

    return NextResponse.json({
      enhancedCaption,
    });
  } catch (error: unknown) {
    // Covers the provider fetch and the read of its body (same signal).
    if (isAiTimeoutError(error)) {
      console.error("[Enhance Caption] Provider call timed out");
      return aiTimeoutResponse();
    }
    console.error("[Enhance Caption] Error:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to enhance caption" },
      { status: 500 },
    );
  }
}
