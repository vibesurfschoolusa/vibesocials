import { PrismaClient } from "@prisma/client";

import { openTokenFields, sealTokenFields } from "./tokenCrypto";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

/**
 * Prisma client with SocialConnection token sealing.
 *
 * On create / update / upsert, `accessToken` and `refreshToken` are encrypted
 * before they hit Postgres (see tokenCrypto.ts). On find* results that include
 * those fields, values are decrypted in process so platform clients keep
 * consuming plaintext tokens.
 *
 * Cast back to PrismaClient so the rest of the app's types stay unchanged.
 */
function createPrismaClient(): PrismaClient {
  const base = new PrismaClient({
    log: ["error", "warn"],
  });

  const extended = base.$extends({
    query: {
      socialConnection: {
        async $allOperations({ operation, args, query }) {
          const writeOps = new Set([
            "create",
            "update",
            "upsert",
            "createMany",
            "updateMany",
          ]);

          if (writeOps.has(operation)) {
            const a = args as {
              data?: Record<string, unknown>;
              create?: Record<string, unknown>;
              update?: Record<string, unknown>;
            };

            if (operation === "upsert") {
              if (a.create) {
                a.create = sealTokenFields(
                  a.create as { accessToken?: string; refreshToken?: string | null },
                ) as Record<string, unknown>;
              }
              if (a.update) {
                a.update = sealTokenFields(
                  a.update as { accessToken?: string; refreshToken?: string | null },
                ) as Record<string, unknown>;
              }
            } else if (a.data) {
              // create / update / updateMany / createMany (single-object data)
              if (Array.isArray(a.data)) {
                a.data = a.data.map((row) =>
                  sealTokenFields(
                    row as { accessToken?: string; refreshToken?: string | null },
                  ),
                ) as unknown as Record<string, unknown>;
              } else {
                a.data = sealTokenFields(
                  a.data as { accessToken?: string; refreshToken?: string | null },
                ) as Record<string, unknown>;
              }
            }
          }

          const result = await query(args);

          const readOps = new Set([
            "findUnique",
            "findUniqueOrThrow",
            "findFirst",
            "findFirstOrThrow",
            "findMany",
            "create",
            "update",
            "upsert",
          ]);

          if (!readOps.has(operation) || result == null) {
            return result;
          }

          if (Array.isArray(result)) {
            return result.map((row) => openConnectionRow(row));
          }
          return openConnectionRow(result);
        },
      },
    },
  });

  return extended as unknown as PrismaClient;
}

function openConnectionRow(row: unknown): unknown {
  if (
    row &&
    typeof row === "object" &&
    ("accessToken" in row || "refreshToken" in row)
  ) {
    return openTokenFields(
      row as { accessToken?: string | null; refreshToken?: string | null },
    );
  }
  return row;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
