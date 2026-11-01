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
  tiktokMetadata?: TikTokPostMetadata;
  youtubeMetadata?: YouTubePostMetadata;
}

export interface PublishResult {
  externalPostId?: string | null;
}

export interface PlatformClient {
  publishVideo(ctx: PublishContext): Promise<PublishResult>;
  refreshToken?(connection: SocialConnection): Promise<SocialConnection>;
}
