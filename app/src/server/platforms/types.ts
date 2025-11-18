import type { MediaItem, SocialConnection, User } from "@prisma/client";

export interface PublishContext {
  user: User;
  socialConnection: SocialConnection;
  mediaItem: MediaItem;
  caption: string;
}

export interface PublishResult {
  externalPostId?: string | null;
}

export interface PlatformClient {
  publishVideo(ctx: PublishContext): Promise<PublishResult>;
  refreshToken?(connection: SocialConnection): Promise<SocialConnection>;
}
