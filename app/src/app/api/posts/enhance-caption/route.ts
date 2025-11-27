import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/posts/enhance-caption - Generate AI-enhanced SEO-optimized caption
 */
export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { caption } = body;

    if (!caption || typeof caption !== "string" || !caption.trim()) {
      return NextResponse.json(
        { error: "Caption is required" },
        { status: 400 }
      );
    }

    // Generate AI-enhanced caption using OpenAI
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

    // Build the prompt for SEO-optimized social media caption
    const systemPrompt = `You are a social media expert specializing in creating engaging, SEO-optimized captions for social media posts. Your captions should be:
- Short and concise (1-2 sentences, max 150 characters)
- Include relevant hashtags (2-4)
- Be engaging and call-to-action oriented
- SEO-friendly with keywords naturally integrated
- Suitable for platforms like Instagram, TikTok, YouTube, and X (Twitter)
- Professional yet approachable tone
- Include emojis where appropriate (but don't overdo it)

IMPORTANT: Write ONLY the enhanced caption. Do NOT include:
- Any meta-commentary
- Explanations or notes
- Just the caption text itself`;

    const userPrompt = `Enhance this basic caption into a short, engaging, SEO-optimized social media post:

"${caption.trim()}"

Create an enhanced version that's perfect for social media.`;

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
          temperature: 0.8, // More creative for social media
          max_tokens: 150,
        }),
      }
    );

    if (!openaiResponse.ok) {
      const errorData = await openaiResponse.json().catch(() => ({}));
      console.error("[Enhance Caption] OpenAI API error:", errorData);
      return NextResponse.json(
        { error: "Failed to generate enhanced caption" },
        { status: 500 }
      );
    }

    const openaiData = await openaiResponse.json();
    const enhancedCaption =
      openaiData.choices?.[0]?.message?.content?.trim() || "";

    if (!enhancedCaption) {
      return NextResponse.json(
        { error: "AI generated empty caption" },
        { status: 500 }
      );
    }

    console.log("[Enhance Caption] Generated successfully", {
      originalLength: caption.length,
      enhancedLength: enhancedCaption.length,
    });

    return NextResponse.json({
      enhancedCaption,
    });
  } catch (error: any) {
    console.error("[Enhance Caption] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to enhance caption" },
      { status: 500 }
    );
  }
}
