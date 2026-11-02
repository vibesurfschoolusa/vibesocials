import type { MediaItem, SocialConnection, User } from "@prisma/client";

export interface TikTokPostMetadata {
  privacyLevel: string;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  brandedContent?: boolean;
  brandOrganic?: boolean;
}

export interface TikTokCreatorInfo {
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

export interface PublishContext {
  user: User;
  socialConnection: SocialConnection;
  mediaItem: MediaItem;
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
  tiktokMetadata?: TikTokPostMetadata;
  youtubeMetadata?: YouTubePostMetadata;
}

export interface PublishResult {
  externalPostId?: string | null;
}

export interface PlatformClient {
  publishVideo(ctx: PublishContext): Promise<PublishResult>;
  /**
   * Refresh the connection's OAuth tokens and persist them. Raw: it takes no
   * lock, so callers go through `refreshConnectionToken` (connectionRefresh.ts),
   * which serializes refreshes per connection. `opts.deadline` (epoch ms,
   * publishBudget.ts) bounds the token request; clients that never refresh
   * ignore it.
   */
  refreshToken?(connection: SocialConnection, opts?: { deadline?: number }): Promise<SocialConnection>;
}
