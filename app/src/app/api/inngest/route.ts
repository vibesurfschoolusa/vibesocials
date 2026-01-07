import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest";
import { inngestFunctions } from "@/server/jobs/inngest-functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: inngestFunctions,
  serveHost: process.env.INNGEST_SERVE_HOST || "https://vibesocials.wtf",
});
