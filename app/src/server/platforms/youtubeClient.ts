import type { PlatformClient, PublishContext, PublishResult } from "./types";

export const youtubeClient: PlatformClient = {
  async publishVideo(_ctx: PublishContext): Promise<PublishResult> {
    const error = new Error("YouTube client not implemented");
    (error as any).code = "NOT_IMPLEMENTED";
    throw error;
  },
};
