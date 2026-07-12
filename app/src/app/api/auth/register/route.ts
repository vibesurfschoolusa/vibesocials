import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';

import { prisma } from '@/lib/db';
import { provisionPersonalWorkspace } from '@/lib/workspace';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, password, name } = body ?? {};

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });
    }

    if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email)) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (typeof password !== "string" || password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 },
      );
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json({ error: 'A user with that email already exists.' }, { status: 400 });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Registration creates the User and its personal workspace + owner
    // membership atomically (design doc §2), so a mid-way failure never
    // leaves a user without a workspace. (getWorkspaceContext's self-heal is
    // the backstop for pre-existing gaps, not the normal path.)
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name: name ?? null,
          passwordHash,
        },
      });
      await provisionPersonalWorkspace(tx, created);
      return created;
    });

    return NextResponse.json(
      {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json({ error: 'Failed to register user.' }, { status: 500 });
  }
}
