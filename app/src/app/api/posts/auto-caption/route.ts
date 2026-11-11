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
import { cleanAltText, fitAltText } from "@/lib/altText";
import { BLOB_URL_REJECTED_MESSAGE, isAllowedBlobUrl } from "@/lib/blobUrl";
import { brandVoicePrompt } from "@/lib/brandVoice";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { LLM_NOT_CONFIGURED_MESSAGE, reasoningParams, resolveLlmConfig } from "@/lib/llm";
import { checkRateLimit } from "@/lib/rateLimit";
import { MAX_VIDEO_FRAMES, parseVideoFrames } from "@/lib/videoFrames";
import { getWorkspaceContext } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * 07d: what "Write it for me" asks for. Alt text describes; it does not sell,
 * so neither the brand website nor the brand voice is part of it.
 */
const ALT_TEXT_SYSTEM_PROMPT = `You write alt text: a short description of a photo for someone who cannot see it.
Your description must:
- Be one or two plain sentences, at most 250 characters
- Say what is in the photo: the people, things, place and action, and any words shown in it
- Use no hashtags and no emoji
- Give no opinions and do not sell or promote anything
- Not start with "Image of" or "Photo of"

Return ONLY the description.`;

/** The longest description the AI may hand back (the field holds up to 1,000). */
const AI_ALT_TEXT_MAX = 250;

// An emoji, and the skin-tone modifier or variation selector that may follow it.
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Variation_Selector}]/gu;

interface AutoCaptionRequestBody {
  blobUrl: string;
  mimeType: string;
  platform?: string;
  language?: string;
  tone?: string;
  maxLength?: number;
  /** Up to 3 JPEG data URLs of still frames, for a video (lib/videoFrames.ts). */
  frames?: string[];
  /** True from the Add-many page: a separate per-user counter (40 per 15 minutes). */
  bulk?: boolean;
  /** 07d: "altText" asks for the photo's description instead of a caption. Absent: a caption. */
  purpose?: "altText";
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

    const parsedBody = await readJsonObject(request);
    if (!parsedBody) {
      return invalidJsonBodyResponse();
    }
    // Fields are validated below (typeof checks); `Partial` keeps that honest.
    const body = parsedBody as Partial<AutoCaptionRequestBody>;

    const { blobUrl, mimeType, maxLength } = body;

    // 2026-11-01 scale audit (W6): cap every client string that reaches the
    // provider BEFORE any limiter counter is spent. `platform`/`language`/`tone`
    // are interpolated into the prompt, so only string values are used (an
    // array or object would stringify past the cap); `blobUrl` is forwarded to
    // the provider as the image URL.
    const platform = typeof body.platform === "string" ? body.platform : undefined;
    const language = typeof body.language === "string" ? body.language : undefined;
    const tone = typeof body.tone === "string" ? body.tone : undefined;
    const overlong = findOverlongAiField([
      { field: "platform", value: platform, max: AI_LIMITS.shortField },
      { field: "language", value: language, max: AI_LIMITS.shortField },
      { field: "tone", value: tone, max: AI_LIMITS.shortField },
      { field: "mimeType", value: mimeType, max: AI_LIMITS.shortField },
      { field: "blobUrl", value: blobUrl, max: AI_LIMITS.caption },
    ]);
    if (overlong) {
      return aiInputTooLongResponse(overlong);
    }
    // Video frames are checked here too, before any limiter counter is spent.
    const frames = parseVideoFrames(body.frames);
    if (frames === "invalid") {
      return NextResponse.json(
        { error: `frames must be at most ${MAX_VIDEO_FRAMES} small JPEG images` },
        { status: 400 },
      );
    }

    if (body.bulk !== undefined && typeof body.bulk !== "boolean") {
      return NextResponse.json({ error: "bulk must be true or false" }, { status: 400 });
    }

    if (body.purpose !== undefined && body.purpose !== "altText") {
      return NextResponse.json({ error: 'purpose must be "altText" when given.' }, { status: 400 });
    }
    const wantsAltText = body.purpose === "altText";

    // Throttle per user: vision calls are the most expensive, so keep this tight.
    // Fail closed — a limiter outage must not open unlimited LLM spend.
    // The Add-many page (/posts/bulk) captions up to 20 files one after another,
    // which the 10-per-5-minutes counter would stretch to ten minutes, so it
    // asks for its own counter. The workspace's daily AI quota still applies.
    // 07d: a description ("Write it for me", once per photo of up to ten) has its
    // own counter, so describing a set never uses up the caption's.
    const rateLimit = await checkRateLimit(
      wantsAltText
        ? {
            userId: context.user.id,
            route: "posts/auto-caption-alt-text",
            limit: 30,
            windowMs: 15 * 60 * 1000,
            failClosed: true,
          }
        : body.bulk === true
        ? {
            userId: context.user.id,
            route: "posts/auto-caption-bulk",
            limit: 40,
            windowMs: 15 * 60 * 1000,
            failClosed: true,
          }
        : {
            userId: context.user.id,
            route: "posts/auto-caption",
            limit: 10,
            windowMs: 5 * 60 * 1000,
            failClosed: true,
          },
    );

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

    if (wantsAltText && !isImage) {
      return NextResponse.json({ error: "Only a photo can be described." }, { status: 400 });
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

    if (wantsAltText) {
      return await describePhoto({
        llm,
        imageUrl: trimmedBlobUrl,
        language,
        userId: context.user.id,
      });
    }

    const mediaKind = isImage ? "photo" : "video";
    // A video with frames is shown to the vision model; one without is captioned
    // by the text model from the prompt alone (the old behaviour).
    const videoFrames = isVideo ? frames : [];
    const model = isImage || videoFrames.length > 0 ? llm.visionModel : llm.textModel;

    const brandPieces: string[] = [];
    if (context.workspace.companyWebsite?.trim()) {
      brandPieces.push(`Brand website: ${context.workspace.companyWebsite.trim()}`);
    }

    const platformText = platform ? `Target platform: ${platform}.` : "";
    const languageText = language
      ? `Write the caption in this language: ${language}.`
      : "Write the caption in the same language as the example content or English.";
    // The caller's own workspace only, never the request body (brief 15).
    const voiceBlock = brandVoicePrompt(
      context.workspace.brandVoice,
      context.workspace.brandVoiceExamples,
    );
    // Neither composer sends a tone, so the generic default would contradict a
    // saved voice on every request.
    const toneText = tone
      ? `Preferred tone: ${tone}.`
      : voiceBlock
        ? "Tone: follow the brand voice in the instructions."
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
- Return ONLY the caption text.${voiceBlock}`;

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
    } else if (videoFrames.length > 0) {
      messages = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${baseUserPrompt}

The images are ${videoFrames.length} still frames from the video, in order. Write a caption that fits what the video shows, including any words that appear on screen.`,
            },
            ...videoFrames.map((url) => ({ type: "image_url", image_url: { url } })),
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
        model,
        messages,
        temperature: 0.8,
        max_tokens: 150,
        ...reasoningParams(llm.provider, model),
      }),
      signal: AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS),
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
      videoFrames: videoFrames.length,
      captionLength: caption.length,
    });

    return NextResponse.json({ caption });
  } catch (error: unknown) {
    // Covers the provider fetch and the read of its body (same signal).
    if (isAiTimeoutError(error)) {
      console.error("[Auto Caption] Provider call timed out");
      return aiTimeoutResponse();
    }
    console.error("[Auto Caption] Error:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to generate caption from media" },
      { status: 500 },
    );
  }
}

/**
 * 07d: one vision call that describes the photo, under the guards and counters
 * the caller already passed. The answer is cleaned like a typed description
 * (lib/altText.ts), with hashtags and emoji removed, and cut to 250 characters.
 * Its text is never logged.
 */
async function describePhoto(args: {
  llm: NonNullable<ReturnType<typeof resolveLlmConfig>>;
  imageUrl: string;
  language: string | undefined;
  userId: string;
}): Promise<Response> {
  const { llm, imageUrl, language, userId } = args;
  const languageText = language
    ? `Write the description in this language: ${language}.`
    : "Write the description in English.";
  const model = llm.visionModel;

  const llmResponse = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: ALT_TEXT_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: `Describe this photo for its alt text.\n${languageText}` },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 0.3,
      max_tokens: 150,
      ...reasoningParams(llm.provider, model),
    }),
    signal: AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS),
  });

  if (!llmResponse.ok) {
    console.error(`[Auto Caption] ${llm.providerLabel} API error (alt text)`, { status: llmResponse.status });
    return NextResponse.json(
      { error: "The AI could not describe this photo. Try again or write it yourself." },
      { status: 500 },
    );
  }

  const llmData = await llmResponse.json();
  const raw = llmData.choices?.[0]?.message?.content;
  const altText = fitAltText(
    cleanAltText(typeof raw === "string" ? raw.replace(/#/g, "").replace(EMOJI, "") : "").replace(/ {2,}/g, " "),
    AI_ALT_TEXT_MAX,
  );

  if (!altText) {
    return NextResponse.json(
      { error: "The AI wrote an empty description. Try again or write it yourself." },
      { status: 500 },
    );
  }

  console.log("[Auto Caption] Photo description generated", { userId, length: altText.length });
  return NextResponse.json({ altText });
}
