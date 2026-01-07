import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest";
import { inngestFunctions } from "@/server/jobs/inngest-functions";

// Force production URL for Inngest sync
const serveHandler = serve({
  client: inngest,
  functions: inngestFunctions,
});

export const GET = serveHandler.GET;
export const POST = serveHandler.POST;
export const PUT = serveHandler.PUT;

// Override the registration URL by setting headers
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
