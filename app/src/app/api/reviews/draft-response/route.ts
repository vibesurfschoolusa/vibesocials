import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/reviews/draft-response - Generate AI-powered review response
 */
export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    // Generate AI response using OpenAI-compatible API
    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!openaiApiKey) {
      return NextResponse.json(
        {
          error:
            "OpenAI API key not configured. Please add OPENAI_API_KEY to your environment variables.",
        },
        { status: 500 }
      );
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

    // Call OpenAI API
    const openaiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini", // Fast and cost-effective
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.7,
          max_tokens: 200,
        }),
      }
    );

    if (!openaiResponse.ok) {
      const errorData = await openaiResponse.json().catch(() => ({}));
      console.error("[Draft Response] OpenAI API error:", errorData);
      return NextResponse.json(
        { error: "Failed to generate AI response" },
        { status: 500 }
      );
    }

    const openaiData = await openaiResponse.json();
    const draftResponse =
      openaiData.choices?.[0]?.message?.content?.trim() || "";

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
  } catch (error: any) {
    console.error("[Draft Response] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate response" },
      { status: 500 }
    );
  }
}
