import { NextResponse } from "next/server";

import { BLOB_URL_REJECTED_MESSAGE, isAllowedBlobUrl } from "@/lib/blobUrl";
import { LLM_NOT_CONFIGURED_MESSAGE, resolveLlmConfig } from "@/lib/llm";
import { checkRateLimit } from "@/lib/rateLimit";
import { getWorkspaceContext } from "@/lib/workspace";

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
    // Team Workspaces sweep (Task 8): was `getCurrentUser()` reading
    // `user.companyWebsite` directly — that column stopped being written
    // once Task 7 moved the caption-footer fields to Workspace (`POST
    // /api/settings` is owner-only and workspace-scoped now), so any
    // workspace whose brand website was set/changed post-migration would
    // silently fall back to a stale or empty User row here. Any member may
    // auto-caption (design §1 — composing is member-level), so
    // `getWorkspaceContext()` with no `requireRole` is the right gate.
    const context = await getWorkspaceContext();

    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Throttle per user: vision calls are the most expensive, so keep this tight.
    // Fail closed — a limiter outage must not open unlimited LLM spend.
    const rateLimit = await checkRateLimit({
      userId: context.user.id,
      route: "posts/auto-caption",
      limit: 10,
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

    // SSRF guard: the image path hands blobUrl to the LLM provider to fetch as
    // an image_url. Same host allowlist as media/posts create.
    if (!isAllowedBlobUrl(trimmedBlobUrl)) {
      return NextResponse.json({ error: BLOB_URL_REJECTED_MESSAGE }, { status: 400 });
    }

    const isImage = trimmedMimeType.startsWith("image/");
    const isVideo = trimmedMimeType.startsWith("video/");

    if (!isImage && !isVideo) {
      return NextResponse.json(
        { error: "Only image and video media are supported for auto-caption" },
        { status: 400 },
      );
    }

    const llm = resolveLlmConfig();
    if (!llm) {
      return NextResponse.json({ error: LLM_NOT_CONFIGURED_MESSAGE }, { status: 500 });
    }

    const mediaKind = isImage ? "photo" : "video";

    const brandPieces: string[] = [];
    if (context.workspace.companyWebsite?.trim()) {
      brandPieces.push(`Brand website: ${context.workspace.companyWebsite.trim()}`);
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

    type ChatMessage = {
      role: string;
      content:
        | string
        | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    };
    let messages: ChatMessage[];

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

    const llmResponse = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: isImage ? llm.visionModel : llm.textModel,
        messages,
        temperature: 0.8,
        max_tokens: 150,
      }),
    });

    if (!llmResponse.ok) {
      const errorData = await llmResponse.json().catch(() => ({}));
      console.error(`[Auto Caption] ${llm.providerLabel} API error:`, errorData);
      return NextResponse.json(
        { error: "Failed to generate caption from media" },
        { status: 500 },
      );
    }

    const llmData = await llmResponse.json();
    let caption = llmData.choices?.[0]?.message?.content?.trim() ?? "";

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
      userId: context.user.id,
      mediaKind,
      mimeType: trimmedMimeType,
      captionLength: caption.length,
    });

    return NextResponse.json({ caption });
  } catch (error: unknown) {
    console.error("[Auto Caption] Error:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to generate caption from media" },
      { status: 500 },
    );
  }
}
