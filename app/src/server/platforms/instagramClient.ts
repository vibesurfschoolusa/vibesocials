import type { PlatformClient, PublishContext, PublishResult } from "./types";

export const instagramClient: PlatformClient = {
  async publishVideo(_ctx: PublishContext): Promise<PublishResult> {
    const error = new Error("Instagram client not implemented");
    (error as any).code = "NOT_IMPLEMENTED";
    throw error;
  },
};
