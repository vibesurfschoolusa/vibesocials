import type { MediaItem, SocialConnection, User } from "@prisma/client";

import type { UploadStateStore } from "@/server/jobs/uploadState";

export interface TikTokPostMetadata {
  privacyLevel: string;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  brandedContent?: boolean;
  brandOrganic?: boolean;
}

export interface TikTokCreatorInfo {
  /** Shown on the posting screen (TikTok guideline 1a). Falls back to the username. */
  creatorNickname: string;
  creatorUsername: string;
  creatorAvatarUrl: string;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

export interface YouTubePostMetadata {
  privacyStatus: "public" | "unlisted" | "private";
}

/**
 * A Google Business Profile post's options (2026-11-10). Dates are `YYYY-MM-DD`
 * and times `HH:MM`, in the business's local time with no time zone. No `button`
 * means no button. An absent metadata object (a post from before this change,
 * or from the API) is a different thing: it gets the workspace's default button.
 */
export interface GoogleBusinessPostMetadata {
  postType: "update" | "event" | "offer";
  button?: { type: "BOOK" | "ORDER" | "SHOP" | "LEARN_MORE" | "SIGN_UP" | "CALL"; url?: string };
  event?: { title: string; startDate: string; endDate: string; startTime?: string; endTime?: string };
  offer?: {
    title: string;
    startDate: string;
    endDate: string;
    couponCode?: string;
    redeemUrl?: string;
    terms?: string;
  };
}

/**
 * Feed or Story (2026-11-10, lib/storyPlacement.ts). Absent means feed, the
 * behaviour of every post before this option existed.
 */
export interface InstagramPostMetadata {
  placement: "feed" | "story";
}

/** Feed or Story for a Facebook Page; absent means feed. */
export interface FacebookPostMetadata {
  placement: "feed" | "story";
}

export interface PublishContext {
  user: User;
  socialConnection: SocialConnection;
  /**
   * The post's first (or only) file, with its caption fields. The same file as
   * `mediaItems[0]`, which carries the file fields only.
   */
  mediaItem: MediaItem;
  /**
   * The post's files in order (07a): one for a single photo or video, up to
   * MAX_POST_MEDIA photos for a post with several. Never empty.
   *
   * File fields only: in every entry `baseCaption` is "" and
   * `perPlatformOverrides` is null, so the publish steps' saved output stays
   * small. A client takes the text from `caption` / `baseCaption` above (or
   * `mediaItem`), never from this list.
   */
  mediaItems: MediaItem[];
  /** The text to publish: the post's (override or base) caption + workspace footer. */
  caption: string;
  /**
   * The post's own base caption, without footer or per-platform override —
   * the job's snapshot first, `mediaItem.baseCaption` only for legacy jobs
   * (see resolvePostCaptionSource). YouTube titles the video with it. Absent
   * means "use mediaItem.baseCaption".
   */
  baseCaption?: string;
  /**
   * Epoch ms by which this platform step must stop talking to the platform
   * (publishBudget.ts). Stamped once per step by publishToPlatform and shared
   * by its in-step retries; clients with long phases (X, TikTok) bound their
   * requests and polling by it. Absent = unbounded (direct callers, tests).
   */
  deadline?: number;
  /**
   * Where a chunked upload keeps its progress between steps (uploadState.ts).
   * Always set by publishToPlatform; a client treats an absent store (a direct
   * caller, a test) as "do today's whole upload inside this one step".
   */
  uploadState?: UploadStateStore;
  /**
   * 0 in a platform's first step of the run, n in its n-th continuation step
   * (`<stepId>-c<n>`, platformSteps.ts). Absent = 0.
   */
  continuation?: number;
  tiktokMetadata?: TikTokPostMetadata;
  youtubeMetadata?: YouTubePostMetadata;
  /**
   * The post's Google options. Absent: the client applies the workspace's
   * default button (googleBusinessProfileClient.ts).
   */
  googleBusinessProfileMetadata?: GoogleBusinessPostMetadata;
  /** Instagram feed or Story. Absent: feed. */
  instagramMetadata?: InstagramPostMetadata;
  /** Facebook Page feed or Story. Absent: feed. */
  facebookMetadata?: FacebookPostMetadata;
}

/**
 * A post that is only text (2026-11-10): the context without the file fields.
 * `baseCaption` is always the post's own text here (a text post always has its
 * snapshot on the job).
 */
export type TextPublishContext = Omit<PublishContext, "mediaItem" | "mediaItems">;

export interface PublishResult {
  externalPostId?: string | null;
  /**
   * The post's public link, when `externalPostId` can't be turned into one
   * (Instagram's media id). Only an https URL the platform returned; saved as
   * PostJobResult.externalPostUrl and shown in Activity.
   */
  externalPostUrl?: string | null;
  /**
   * The client made progress and has more to do: chunks left, processing not
   * done, or too little step time left for the commit call. It MUST have saved
   * its state in `ctx.uploadState` first. publishToPlatform releases the claim
   * and the run calls the platform again in a continuation step. `resumeAt` is
   * the epoch ms the next step should start no sooner than; null means "call
   * again now". Never set together with a post: the commit call and the work
   * after it finish inside one step.
   */
  continuation?: { resumeAt: number | null };
}

export interface PlatformClient {
  publishVideo(ctx: PublishContext): Promise<PublishResult>;
  /**
   * Publish a post that has no file (2026-11-10). Only the clients of
   * TEXT_ONLY_PLATFORMS (lib/platformLimits.ts) have it; the publish function
   * fails a platform without it instead of calling `publishVideo`.
   */
  publishText?(ctx: TextPublishContext): Promise<PublishResult>;
  /**
   * Refresh the connection's OAuth tokens and persist them. Raw: it takes no
   * lock, so callers go through `refreshConnectionToken` (connectionRefresh.ts),
   * which serializes refreshes per connection. `opts.deadline` (epoch ms,
   * publishBudget.ts) bounds the token request; clients that never refresh
   * ignore it.
   */
  refreshToken?(connection: SocialConnection, opts?: { deadline?: number }): Promise<SocialConnection>;
}
