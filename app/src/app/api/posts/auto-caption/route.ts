import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface AutoCaptionRequestBody {
  blobUrl: string;
  mimeType: string;
  platform?: string;
  language?: string;
  tone?: string;
  maxLength?: number;
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: AutoCaptionRequestBody;
    try {
      body = (await request.json()) as AutoCaptionRequestBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { blobUrl, mimeType, platform, language, tone, maxLength } = body;

    if (!blobUrl || typeof blobUrl !== "string" || !blobUrl.trim()) {
      return NextResponse.json(
        { error: "blobUrl is required" },
        { status: 400 },
      );
    }

    if (!mimeType || typeof mimeType !== "string") {
      return NextResponse.json(
        { error: "mimeType is required" },
        { status: 400 },
      );
    }

    const trimmedBlobUrl = blobUrl.trim();
    const trimmedMimeType = mimeType.trim().toLowerCase();

    const isImage = trimmedMimeType.startsWith("image/");
    const isVideo = trimmedMimeType.startsWith("video/");

    if (!isImage && !isVideo) {
      return NextResponse.json(
        { error: "Only image and video media are supported for auto-caption" },
        { status: 400 },
      );
    }

    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!openaiApiKey) {
      return NextResponse.json(
        {
          error:
            "OpenAI API key not configured. Please add OPENAI_API_KEY to your environment variables.",
        },
        { status: 500 },
      );
    }

    const mediaKind = isImage ? "photo" : "video";

    const brandPieces: string[] = [];
    if (user.companyWebsite?.trim()) {
      brandPieces.push(`Brand website: ${user.companyWebsite.trim()}`);
    }

    const platformText = platform ? `Target platform: ${platform}.` : "";
    const languageText = language
      ? `Write the caption in this language: ${language}.`
      : "Write the caption in the same language as the example content or English.";
    const toneText = tone
      ? `Preferred tone: ${tone}.`
      : "Tone: friendly, energetic, and on-brand for a local business.";

    const lengthText =
      typeof maxLength === "number" && maxLength > 0
        ? `The caption must be at most ${maxLength} characters.`
        : "Keep the caption short (1-2 sentences, max ~150 characters).";

    const systemPrompt = `You are a social media expert creating short, engaging captions for photos and videos.
Your captions must:
- Be plain text only with NO hashtags (do not use the '#' character at all)
- Be engaging and call-to-action oriented
- Be suitable for platforms like Instagram, TikTok, YouTube, LinkedIn, X, and Facebook
- Feel professional yet approachable
- Optionally include emojis, but don't overdo it
${brandPieces.length > 0 ? `\nBrand context:\n${brandPieces.join("\n")}` : ""}

IMPORTANT:
- Do NOT include hashtags.
- Do NOT include any meta-commentary or instructions.
- Return ONLY the caption text.`;

    const baseUserPrompt = `Create a social media caption for a ${mediaKind} for this business.
${platformText}
${languageText}
${toneText}
${lengthText}`.trim();

    let messages: any[];

    if (isImage) {
      messages = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: baseUserPrompt,
            },
            {
              type: "image_url",
              image_url: {
                url: trimmedBlobUrl,
              },
            },
          ],
        },
      ];
    } else {
      messages = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${baseUserPrompt}

The media is a short social media video. You do not have direct access to the video frames; create a caption that would fit typical content from this business.`,
        },
      ];
    }

    const openaiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: isImage ? "gpt-4o" : "gpt-4o-mini",
          messages,
          temperature: 0.8,
          max_tokens: 150,
        }),
      },
    );

    if (!openaiResponse.ok) {
      const errorData = await openaiResponse.json().catch(() => ({}));
      console.error("[Auto Caption] OpenAI API error:", errorData);
      return NextResponse.json(
        { error: "Failed to generate caption from media" },
        { status: 500 },
      );
    }

    const openaiData = await openaiResponse.json();
    let caption = openaiData.choices?.[0]?.message?.content?.trim() ?? "";

    caption = caption.replace(/#/g, "").trim();

    if (typeof maxLength === "number" && maxLength > 0 && caption.length > maxLength) {
      caption = caption.slice(0, maxLength).trim();
    }

    if (!caption) {
      return NextResponse.json(
        { error: "AI generated empty caption" },
        { status: 500 },
      );
    }

    console.log("[Auto Caption] Generated successfully", {
      userId: user.id,
      mediaKind,
      mimeType: trimmedMimeType,
      captionLength: caption.length,
    });

    return NextResponse.json({ caption });
  } catch (error: any) {
    console.error("[Auto Caption] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate caption from media" },
      { status: 500 },
    );
  }
}
