import type { PlatformClient, PublishContext, PublishResult } from "./types";

export const xClient: PlatformClient = {
  async publishVideo(_ctx: PublishContext): Promise<PublishResult> {
    const error = new Error("X (Twitter) client not implemented");
    (error as any).code = "NOT_IMPLEMENTED";
    throw error;
  },
};
