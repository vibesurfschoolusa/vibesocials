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
import { BRAND_VOICE_REVIEW_LINE, workspaceBrandVoicePrompt } from "@/lib/brandVoice";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { accessBlockResponse } from "@/lib/workspaceStatus";
import { LLM_NOT_CONFIGURED_MESSAGE, reasoningParams, resolveLlmConfig } from "@/lib/llm";
import { checkRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// What a person reads when the AI did not answer, whatever the cause: the
// cause (configuration, the provider's own error) goes to the server log only.
const DRAFT_FAILED_MESSAGE = "The AI could not write a reply. Try again, or write one yourself.";

/**
 * POST /api/reviews/draft-response - Generate AI-powered review response.
 * Any member may draft a reply (Team Workspaces — design §1: "Reply to
 * Google reviews (incl. AI draft)" is member-level). No workspace-scoped
 * data is read here (no GBP connection lookup) — the burst limit stays
 * per-CALLING-user; the shared daily AI quota (2026-11-01 scale audit, W6) is
 * per-workspace.
 */
export async function POST(request: Request) {
  try {
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
    const { starRating } = body;

    // 2026-11-01 scale audit (W6): cap every client string that reaches the
    // prompt BEFORE any limiter counter is spent. Only string values are used
    // (an array or object would stringify past the cap).
    const reviewerName = typeof body.reviewerName === "string" ? body.reviewerName : undefined;
    const comment = typeof body.comment === "string" ? body.comment : undefined;
    const businessName = typeof body.businessName === "string" ? body.businessName : undefined;
    const overlong = findOverlongAiField([
      { field: "reviewerName", value: reviewerName, max: AI_LIMITS.name },
      { field: "businessName", value: businessName, max: AI_LIMITS.name },
      { field: "comment", value: comment, max: AI_LIMITS.reviewComment },
      { field: "starRating", value: starRating, max: AI_LIMITS.shortField },
    ]);
    if (overlong) {
      return aiInputTooLongResponse(overlong);
    }

    // Throttle per user to cap LLM spend; fail closed on limiter outage.
    const rateLimit = await checkRateLimit({
      userId: context.user.id,
      route: "reviews/draft-response",
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
        }
      );
    }

    if (!reviewerName || !starRating) {
      return NextResponse.json(
        { error: "Reviewer name and star rating are required" },
        { status: 400 }
      );
    }

    // Convert star rating to number
    const ratingMap: Record<string, number> = {
      ONE: 1,
      TWO: 2,
      THREE: 3,
      FOUR: 4,
      FIVE: 5,
    };
    const ratingNumber = ratingMap[String(starRating)] || 5;

    const llm = resolveLlmConfig();
    if (!llm) {
      console.error(`[Draft Response] ${LLM_NOT_CONFIGURED_MESSAGE}`);
      return NextResponse.json({ error: DRAFT_FAILED_MESSAGE }, { status: 500 });
    }

    // 2026-11-01 scale audit (W6): per-workspace daily budget, spent only once
    // the request is valid and a provider is configured.
    const quota = await checkWorkspaceAiQuota(context.workspace.id);
    if (!quota.allowed) {
      return aiWorkspaceLimitResponse(quota.retryAfterSeconds);
    }

    // Determine response tone based on rating
    let tone = "";
    if (ratingNumber >= 4) {
      tone = "grateful and enthusiastic";
    } else if (ratingNumber === 3) {
      tone = "appreciative but acknowledging there's room for improvement";
    } else {
      tone = "empathetic, apologetic, and focused on making things right";
    }

    // After the route's own rules, from the caller's own workspace only (brief 15).
    // P1: only where the plan includes the brand voice.
    const voiceBlock = workspaceBrandVoicePrompt(context.workspace);
    const voiceSection = voiceBlock ? [voiceBlock, BRAND_VOICE_REVIEW_LINE].join("\n") : "";

    // Build the prompt
    const systemPrompt = `You are a professional business owner responding to a Google review. Your responses should be:
- Professional yet warm and personable
- Genuine and authentic (avoid corporate jargon)
- ${tone}
- Brief (2-3 sentences maximum)
- Personalized to the specific review
- End with an invitation to return or continue the relationship

${businessName ? `The business name is: ${businessName}` : ""}

IMPORTANT: Write ONLY the response text. Do NOT include:
- Greetings like "Dear [name]"
- Sign-offs or signatures
- Your name or business name at the end
- Any meta-commentary

Just write the actual reply message that will be posted publicly.${voiceSection}`;

    const userPrompt = `Review from ${reviewerName}:
Rating: ${ratingNumber}/5 stars
${comment ? `Comment: "${comment}"` : "No written comment"}

Generate a professional, warm response to this review.`;

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
        temperature: 0.7,
        max_tokens: 200,
        ...reasoningParams(llm.provider, llm.textModel),
      }),
      signal: AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS),
    });

    if (!llmResponse.ok) {
      const errorData = await llmResponse.json().catch(() => ({}));
      console.error(`[Draft Response] ${llm.providerLabel} API error:`, errorData);
      return NextResponse.json({ error: DRAFT_FAILED_MESSAGE }, { status: 500 });
    }

    const llmData = await llmResponse.json();
    const draftResponse = llmData.choices?.[0]?.message?.content?.trim() || "";

    if (!draftResponse) {
      console.error(`[Draft Response] ${llm.providerLabel} returned an empty reply`);
      return NextResponse.json({ error: DRAFT_FAILED_MESSAGE }, { status: 500 });
    }

    console.log("[Draft Response] Generated successfully", {
      reviewerName,
      starRating,
      responseLength: draftResponse.length,
    });

    return NextResponse.json({
      draftResponse,
    });
  } catch (error: unknown) {
    // Covers the provider fetch and the read of its body (same signal).
    if (isAiTimeoutError(error)) {
      console.error("[Draft Response] Provider call timed out");
      return aiTimeoutResponse();
    }
    console.error("[Draft Response] Error:", error);
    return NextResponse.json({ error: DRAFT_FAILED_MESSAGE }, { status: 500 });
  }
}
