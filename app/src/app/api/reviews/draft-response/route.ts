import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/workspace";
import { LLM_NOT_CONFIGURED_MESSAGE, resolveLlmConfig } from "@/lib/llm";
import { checkRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * POST /api/reviews/draft-response - Generate AI-powered review response.
 * Any member may draft a reply (Team Workspaces — design §1: "Reply to
 * Google reviews (incl. AI draft)" is member-level). No workspace-scoped
 * data is read here (no GBP connection lookup) — rate limiting stays
 * per-CALLING-user, not per-workspace.
 */
export async function POST(request: Request) {
  try {
    const context = await getWorkspaceContext();

    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    const body = await request.json();
    const { reviewerName, starRating, comment, businessName } = body;

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
    const ratingNumber = ratingMap[starRating] || 5;

    const llm = resolveLlmConfig();
    if (!llm) {
      return NextResponse.json({ error: LLM_NOT_CONFIGURED_MESSAGE }, { status: 500 });
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

Just write the actual reply message that will be posted publicly.`;

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
      }),
    });

    if (!llmResponse.ok) {
      const errorData = await llmResponse.json().catch(() => ({}));
      console.error(`[Draft Response] ${llm.providerLabel} API error:`, errorData);
      return NextResponse.json(
        { error: "Failed to generate AI response" },
        { status: 500 },
      );
    }

    const llmData = await llmResponse.json();
    const draftResponse = llmData.choices?.[0]?.message?.content?.trim() || "";

    if (!draftResponse) {
      return NextResponse.json(
        { error: "AI generated empty response" },
        { status: 500 }
      );
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
    console.error("[Draft Response] Error:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to generate response" },
      { status: 500 }
    );
  }
}
