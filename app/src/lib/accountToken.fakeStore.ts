import type { AccountTokenType } from "@prisma/client";

/**
 * Test support only: an in-memory AccountToken table that answers the two
 * calls lib/accountToken.ts makes, so tests can check which links still work
 * after a send rather than which calls were made. Each create gets a later
 * createdAt than the one before, as the database default would.
 */
export type FakeTokenRow = {
  id: string;
  userId: string;
  type: AccountTokenType;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
};

type Where = {
  id?: string;
  userId?: string;
  type?: AccountTokenType;
  usedAt?: null;
  createdAt?: { lt: Date };
};

function matches(row: FakeTokenRow, where: Where): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.type !== undefined && row.type !== where.type) return false;
  if (where.usedAt === null && row.usedAt !== null) return false;
  if (where.createdAt && !(row.createdAt.getTime() < where.createdAt.lt.getTime())) return false;
  return true;
}

export function makeFakeAccountTokenStore(start = new Date("2026-11-20T00:00:00.000Z")) {
  const rows: FakeTokenRow[] = [];
  let seq = 0;
  const accountToken = {
    async create(args: { data: Omit<FakeTokenRow, "id" | "createdAt" | "usedAt">; select?: unknown }) {
      seq += 1;
      const row: FakeTokenRow = {
        ...args.data,
        id: `tok_${seq}`,
        usedAt: null,
        createdAt: new Date(start.getTime() + seq),
      };
      rows.push(row);
      return { ...row };
    },
    async deleteMany(args: { where: Where }) {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matches(rows[i], args.where)) {
          rows.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    },
  };
  return {
    rows,
    /** A row as an earlier request or a used link left it. */
    seed(row: Partial<FakeTokenRow> & Pick<FakeTokenRow, "userId" | "type" | "tokenHash">) {
      seq += 1;
      rows.push({
        id: `tok_${seq}`,
        expiresAt: new Date(start.getTime() + 60 * 60 * 1000),
        usedAt: null,
        createdAt: new Date(start.getTime() + seq),
        ...row,
      });
    },
    hashes: () => rows.map((row) => row.tokenHash),
    db: { accountToken } as unknown as import("./accountToken").PrismaClientLike2,
  };
}
