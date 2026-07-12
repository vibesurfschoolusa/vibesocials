import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireOwnerContext } from "@/lib/workspace";

const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 60;

interface PatchBody {
  name?: unknown;
}

/**
 * PATCH /api/workspaces/active { name }
 *
 * Owner-only rename of the caller's active workspace (design doc §4). Footer
 * fields (companyWebsite/defaultHashtags) stay on `POST /api/settings` — not
 * handled here.
 */
export async function PATCH(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const context = contextOrError;

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.name !== "string") {
    return NextResponse.json({ error: "Name is required." }, { status: 400 });
  }

  const trimmed = body.name.trim();
  if (trimmed.length < NAME_MIN_LENGTH || trimmed.length > NAME_MAX_LENGTH) {
    return NextResponse.json(
      { error: `Name must be ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} characters.` },
      { status: 400 },
    );
  }

  const updated = await prisma.workspace.update({
    where: { id: context.workspace.id },
    data: { name: trimmed },
    select: { id: true, name: true },
  });

  return NextResponse.json({ id: updated.id, name: updated.name }, { status: 200 });
}
