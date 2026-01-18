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

export interface PublishContext {
  user: User;
  socialConnection: SocialConnection;
  mediaItem: MediaItem;
  caption: string;
  tiktokMetadata?: TikTokPostMetadata;
}

export interface PublishResult {
  externalPostId?: string | null;
}

export interface PlatformClient {
  publishVideo(ctx: PublishContext): Promise<PublishResult>;
  refreshToken?(connection: SocialConnection): Promise<SocialConnection>;
}
