import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { checkRateLimit } from "@/lib/rateLimit";
import { usableTimeZone } from "@/server/notifications/emailTime";
import { signedOutResponse } from "@/lib/signedOutResponse";

/**
 * POST /api/me/time-zone { timeZone } (fix round 1, F4): the signed-in
 * person's browser sends its IANA zone (components/shell/time-zone-sync.tsx)
 * so emails can show times in it. Only a name Intl knows is stored; the same
 * zone again writes nothing.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return signedOutResponse();
  }

  const rateLimit = await checkRateLimit({
    userId: user.id,
    route: "me/time-zone",
    limit: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }

  const timeZone = typeof body.timeZone === "string" ? usableTimeZone(body.timeZone) : null;
  if (!timeZone) {
    return NextResponse.json({ error: "timeZone must be a time zone name such as America/New_York." }, { status: 400 });
  }

  if (user.timeZone !== timeZone) {
    await prisma.user.updateMany({ where: { id: user.id }, data: { timeZone } });
  }
  return NextResponse.json({ ok: true, timeZone });
}
