import type { Platform } from "@prisma/client";
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
import { brandVoicePrompt } from "@/lib/brandVoice";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { LLM_NOT_CONFIGURED_MESSAGE, reasoningParams, resolveLlmConfig } from "@/lib/llm";
import { PLATFORM_CAPTION_LIMITS } from "@/lib/platformLimits";
import { ADAPT_MAX_LENGTH_MAX, ADAPT_MAX_LENGTH_MIN } from "@/lib/platformOverrides";
import { PLATFORM_ORDER, platformLabel } from "@/lib/platforms";
import { checkRateLimit } from "@/lib/rateLimit";
import { getWorkspaceContext } from "@/lib/workspace";
import { accessBlockResponse } from "@/lib/workspaceStatus";

export const dynamic = "force-dynamic";

const PROMPT_OUTPUT_RULES = `IMPORTANT: Write ONLY the enhanced caption as plain text without any hashtags. Do NOT include:
- Any meta-commentary
- Explanations or notes
- Just the caption text itself`;

// What suits each platform when "Adapt for {platform}" rewrites a caption.
const PLATFORM_GUIDANCE: Record<Platform, (maxLength: number | undefined) => string> = {
  x: (maxLength) =>
    `One or two short sentences. Must fit ${maxLength ?? PLATFORM_CAPTION_LIMITS.x.charLimit} characters.`,
  instagram: () => "Friendly and personal, a short opening line that works on its own.",
  facebook_page: () => "Friendly and conversational, two to four sentences.",
  linkedin: () => "Professional and plain, two or three sentences, no slang.",
  google_business_profile: () =>
    "What is offered and where, plainly, for someone finding the business on Maps.",
  tiktok: () => "Short, casual, one or two sentences.",
  youtube: () =>
    "The first sentence must work as the video's title; then one or two sentences of description.",
  pinterest: () => "Descriptive, with the words someone would search for.",
};

function adaptSystemPrompt(platform: Platform, maxLength: number | undefined): string {
  const lines = [
    `- Written for ${platformLabel(platform)}: ${PLATFORM_GUIDANCE[platform](maxLength)}`,
    ...(maxLength ? [`- At most ${maxLength} characters`] : []),
    "- Use plain text only with NO hashtags (no '#' characters at all)",
  ];
  return `You are a social media expert who rewrites a caption so it suits one platform. The caption should be:
${lines.join("\n")}

${PROMPT_OUTPUT_RULES}`;
}

// What a person reads when the AI did not answer, whatever the cause: the
// cause (configuration, the provider's own error) goes to the server log only.
const ENHANCE_FAILED_MESSAGE = "The AI could not improve the caption. Try again.";
const adaptFailedMessage = (platform: Platform) => `Couldn't adapt the caption for ${platformLabel(platform)}. Try again.`;

/**
 * POST /api/posts/enhance-caption - Generate AI-enhanced SEO-optimized caption
 */
export async function POST(request: Request) {
  // Set once the request names a platform to adapt for; the catch below reads it.
  let failedMessage = ENHANCE_FAILED_MESSAGE;
  try {
    // 2026-11-01 scale audit (W6): was `getCurrentUser()`. The per-workspace
    // daily AI quota needs a workspace id, so this resolves the workspace
    // context (any member may enhance a caption - composing is member-level).
    // The per-user limit below still keys on the same user id as before.
    const context = await getWorkspaceContext();

    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Pause (2026-11-10): a paused workspace cannot create or move work.
    const blocked = accessBlockResponse(context);
    if (blocked) return blocked;

    const body = await readJsonObject(request);
    if (!body) {
      return invalidJsonBodyResponse();
    }
    const { caption, platform, maxLength } = body;

    // 2026-11-01 scale audit (W6): cap the prompt text BEFORE any limiter
    // counter is spent or the provider is called.
    const overlong = findOverlongAiField([
      { field: "caption", value: caption, max: AI_LIMITS.caption },
    ]);
    if (overlong) {
      return aiInputTooLongResponse(overlong);
    }

    // "Adapt for {platform}": both fields optional, checked before any limiter
    // counter is spent.
    if (platform !== undefined && !PLATFORM_ORDER.includes(platform as Platform)) {
      return NextResponse.json({ error: "Unknown platform." }, { status: 400 });
    }
    if (
      maxLength !== undefined &&
      !(
        typeof maxLength === "number" &&
        Number.isInteger(maxLength) &&
        maxLength >= ADAPT_MAX_LENGTH_MIN &&
        maxLength <= ADAPT_MAX_LENGTH_MAX
      )
    ) {
      return NextResponse.json(
        { error: "maxLength must be a whole number from 50 to 10,000." },
        { status: 400 },
      );
    }
    const adaptPlatform = platform as Platform | undefined;
    const adaptMaxLength = maxLength as number | undefined;
    if (adaptPlatform) failedMessage = adaptFailedMessage(adaptPlatform);

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
      console.error(`[Enhance Caption] ${LLM_NOT_CONFIGURED_MESSAGE}`);
      return NextResponse.json({ error: failedMessage }, { status: 500 });
    }

    // 2026-11-01 scale audit (W6): per-workspace daily budget, spent only once
    // the request is valid and a provider is configured.
    const quota = await checkWorkspaceAiQuota(context.workspace.id);
    if (!quota.allowed) {
      return aiWorkspaceLimitResponse(quota.retryAfterSeconds);
    }

    const basePrompt = adaptPlatform
      ? adaptSystemPrompt(adaptPlatform, adaptMaxLength)
      : `You are a social media expert specializing in creating engaging, SEO-optimized captions for social media posts. Your captions should be:
- Short and concise (1-2 sentences, max 150 characters)
- Use plain text only with NO hashtags (no '#' characters at all)
- Be engaging and call-to-action oriented
- SEO-friendly with keywords naturally integrated
- Suitable for platforms like Instagram, TikTok, YouTube, and X (Twitter)
- Professional yet approachable tone
- Include emojis where appropriate (but don't overdo it)${
          adaptMaxLength ? `\n- At most ${adaptMaxLength} characters` : ""
        }

${PROMPT_OUTPUT_RULES}`;
    // After the route's own rules, from the caller's own workspace only (brief 15).
    const systemPrompt = `${basePrompt}${brandVoicePrompt(
      context.workspace.brandVoice,
      context.workspace.brandVoiceExamples,
    )}`;

    const userPrompt = adaptPlatform
      ? `Rewrite this caption for ${platformLabel(adaptPlatform)}:

"${caption.trim()}"`
      : `Enhance this basic caption into a short, engaging, SEO-optimized social media post:

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
        // Adapted captions may run to a few sentences (LinkedIn, YouTube).
        max_tokens: adaptPlatform ? 400 : 150,
        ...reasoningParams(llm.provider, llm.textModel),
      }),
      signal: AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS),
    });

    if (!llmResponse.ok) {
      const errorData = await llmResponse.json().catch(() => ({}));
      console.error(`[Enhance Caption] ${llm.providerLabel} API error:`, errorData);
      return NextResponse.json({ error: failedMessage }, { status: 500 });
    }

    const llmData = await llmResponse.json();
    let enhancedCaption = llmData.choices?.[0]?.message?.content?.trim() || "";

    enhancedCaption = enhancedCaption.replace(/#/g, "").trim();

    if (!enhancedCaption) {
      console.error(`[Enhance Caption] ${llm.providerLabel} returned an empty caption`);
      return NextResponse.json({ error: failedMessage }, { status: 500 });
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
    return NextResponse.json({ error: failedMessage }, { status: 500 });
  }
}
