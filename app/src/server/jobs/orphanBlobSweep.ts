import { del as blobDel, list as blobList } from "@vercel/blob";

import { guardBlobKey } from "@/lib/blobUrl";
import { prisma } from "@/lib/db";
import { inngest } from "@/lib/inngest";
import { logger } from "@/lib/logger";
import { BLOB_DELETE_TIMEOUT_MS } from "@/server/jobs/mediaBlob";
import { pruneUsageEvents } from "@/server/usage/usageLog";

/**
 * Uploads nobody registered (F5, review R1 M3). A browser gets an upload token,
 * writes the file, then registers it as a MediaItem; when the last step never
 * happens (the tab closed, the link's day was full) the file stays in storage,
 * uncounted and never deleted. Once a day this lists the three upload places and
 * deletes the old files that no MediaItem, video cover or report logo refers to.
 *
 * The places: client upload links write `ul/<link id>/<16 hex>-<name>`
 * (lib/uploadLink.ts); signed-in uploads write `<ms>-<random>-<name>` at the
 * root (lib/blobKey.ts); video covers go to `covers/<workspace>/<name>`
 * (lib/coverBlobPath.ts). /api/upload signs no other pathname (R2 M1). Logos
 * (`logos/`) are the server's own and never listed; the shape checks below
 * leave any other file alone. Each day the run starts at the next place, so a
 * place too large for one run's time cannot keep the others from being swept.
 *
 * Never deletes a referenced file (a soft-deleted row counts too). A page's
 * files are matched exactly in one query per table (indexed columns); the
 * files that matched nothing are then looked for by path in one query per
 * table, which finds old rows that spell the address another way. Right before
 * a delete, holding the file's advisory lock (pg_advisory_xact_lock on
 * guardBlobKey), the file is matched exactly again: every registration since
 * stores the canonical address (canonicalBlobUrl), so an exact match on its
 * spellings (the store's public and private host) finds any row written while
 * the run went on, without a scan per file. Only the client link registration
 * (POST /api/upload-link/[token]/media) and the deletes
 * (deleteBlobUnlessShared in server/jobs/mediaBlob.ts, workspace deletion in
 * server/account/deleteWorkspace.ts) take that lock. The signed-in registrations (POST
 * /api/media, POST /api/posts) take none, and a person may upload on Create and
 * post later, so their files wait a week instead of a day.
 */

/** A client link file is registered by the page right after its upload. */
export const LINK_UPLOAD_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** A signed-in upload may sit in an open Create page before it is posted. */
export const SIGNED_IN_UPLOAD_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** One listing call; a hung call ends the run, and tomorrow's starts again. */
export const ORPHAN_LIST_TIMEOUT_MS = 20_000;
/** How long one run may spend, well inside an Inngest step's limit. */
export const ORPHAN_SWEEP_BUDGET_MS = 120_000;

const LINK_FILE = /^ul\/[A-Za-z0-9_-]+\/[0-9a-f]{16}-[A-Za-z0-9._-]+$/;
const SIGNED_IN_FILE = /^\d{13}-[a-z0-9]*-[^/]+$/;
/** One plain file name in one workspace's folder, as isWorkspaceCoverAddress allows. */
const COVER_FILE = /^covers\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

const DAY_MS = 24 * 60 * 60 * 1000;

const SOURCES = [
  { prefix: "ul/", mode: "expanded" as const, shape: LINK_FILE, minAgeMs: LINK_UPLOAD_MIN_AGE_MS },
  { prefix: undefined, mode: "folded" as const, shape: SIGNED_IN_FILE, minAgeMs: SIGNED_IN_UPLOAD_MIN_AGE_MS },
  // A cover is uploaded on Create or Add many before the post is sent, so it
  // waits as long as a signed-in upload.
  { prefix: "covers/", mode: "expanded" as const, shape: COVER_FILE, minAgeMs: SIGNED_IN_UPLOAD_MIN_AGE_MS },
];

type ListedBlob = { url: string; pathname: string; uploadedAt: Date };
type ListPage = { blobs: ListedBlob[]; hasMore: boolean; cursor?: string };
type SweepDb = Pick<typeof prisma, "mediaItem" | "postJob" | "workspace" | "$transaction">;

export interface OrphanSweepResult {
  listed: number;
  deleted: number;
  kept: number;
  failed: number;
  /** False when the time ran out first; tomorrow's run starts again from the top. */
  finished: boolean;
}

/**
 * The addresses a registration may have stored for this file: canonicalBlobUrl
 * keeps the host it was given, and the store answers on its public and its
 * private host alike (lib/blobUrl.ts ownStoreHosts).
 */
function addressSpellings(url: string): string[] {
  const swapped = url.includes(".public.blob.vercel-storage.com/")
    ? url.replace(".public.blob.vercel-storage.com/", ".private.blob.vercel-storage.com/")
    : url.replace(".private.blob.vercel-storage.com/", ".public.blob.vercel-storage.com/");
  return swapped === url ? [url] : [url, swapped];
}

/** The page's files that some row refers to: exactly first, then by path for the rest. */
async function referencedOnPage(db: SweepDb, blobs: ListedBlob[]): Promise<Set<ListedBlob>> {
  const spellings = blobs.flatMap((blob) => addressSpellings(blob.url));
  const [media, covers, logos] = await Promise.all([
    db.mediaItem.findMany({ where: { storageLocation: { in: spellings } }, select: { storageLocation: true } }),
    db.postJob.findMany({ where: { coverImageUrl: { in: spellings } }, select: { coverImageUrl: true } }),
    db.workspace.findMany({ where: { logoUrl: { in: spellings } }, select: { logoUrl: true } }),
  ]);
  const exact = new Set<string>([
    ...media.map((row) => row.storageLocation),
    ...covers.map((row) => row.coverImageUrl ?? ""),
    ...logos.map((row) => row.logoUrl ?? ""),
  ]);
  const referenced = new Set(blobs.filter((blob) => addressSpellings(blob.url).some((url) => exact.has(url))));
  const rest = blobs.filter((blob) => !referenced.has(blob));
  if (rest.length === 0) return referenced;

  // Old rows (from before canonicalBlobUrl) can carry padding or another case
  // of the host: one search per table for the whole page, not one per file.
  const paths = rest.map((blob) => blob.pathname);
  const [mediaLike, coversLike, logosLike] = await Promise.all([
    db.mediaItem.findMany({
      where: { OR: paths.map((path) => ({ storageLocation: { contains: path } })) },
      select: { storageLocation: true },
    }),
    db.postJob.findMany({
      where: { OR: paths.map((path) => ({ coverImageUrl: { contains: path } })) },
      select: { coverImageUrl: true },
    }),
    db.workspace.findMany({
      where: { OR: paths.map((path) => ({ logoUrl: { contains: path } })) },
      select: { logoUrl: true },
    }),
  ]);
  const stored = [
    ...mediaLike.map((row) => row.storageLocation),
    ...coversLike.map((row) => row.coverImageUrl ?? ""),
    ...logosLike.map((row) => row.logoUrl ?? ""),
  ];
  for (const blob of rest) {
    if (stored.some((value) => value.includes(blob.pathname))) referenced.add(blob);
  }
  return referenced;
}

async function deleteUnlessReferenced(
  db: SweepDb,
  blob: ListedBlob,
  del: (url: string, options: { abortSignal: AbortSignal }) => Promise<void>,
): Promise<"deleted" | "kept"> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${guardBlobKey(blob.url)}))`;
      const spellings = addressSpellings(blob.url);
      const uses =
        (await tx.mediaItem.count({ where: { storageLocation: { in: spellings } } })) +
        (await tx.postJob.count({ where: { coverImageUrl: { in: spellings } } })) +
        (await tx.workspace.count({ where: { logoUrl: { in: spellings } } }));
      if (uses > 0) return "kept";
      // A reason-less abort, as in mediaBlob.ts: the SDK fails fast on it.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BLOB_DELETE_TIMEOUT_MS);
      try {
        await del(blob.url, { abortSignal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      return "deleted";
    },
    { timeout: BLOB_DELETE_TIMEOUT_MS + 5_000 },
  );
}

export async function sweepOrphanBlobs(
  opts: {
    list?: (options: {
      prefix?: string;
      mode: "expanded" | "folded";
      cursor?: string;
      limit: number;
      abortSignal: AbortSignal;
    }) => Promise<ListPage>;
    del?: (url: string, options: { abortSignal: AbortSignal }) => Promise<void>;
    db?: SweepDb;
    now?: () => number;
    budgetMs?: number;
    listTimeoutMs?: number;
  } = {},
): Promise<OrphanSweepResult> {
  const list = opts.list ?? (blobList as unknown as NonNullable<typeof opts.list>);
  const del = opts.del ?? (blobDel as unknown as NonNullable<typeof opts.del>);
  const db = opts.db ?? prisma;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? ORPHAN_SWEEP_BUDGET_MS);
  const result: OrphanSweepResult = { listed: 0, deleted: 0, kept: 0, failed: 0, finished: false };

  // R2 M1: today's place first, then the others in turn.
  const first = Math.floor(now() / DAY_MS) % SOURCES.length;
  const order = SOURCES.map((_, i) => SOURCES[(first + i) % SOURCES.length]);

  for (const source of order) {
    let cursor: string | undefined;
    do {
      if (now() >= deadline) return result;
      let page: ListPage;
      // A reason-less abort, as in mediaBlob.ts: the SDK fails fast on it.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.listTimeoutMs ?? ORPHAN_LIST_TIMEOUT_MS);
      try {
        page = await list({
          prefix: source.prefix,
          mode: source.mode,
          cursor,
          limit: 1000,
          abortSignal: controller.signal,
        });
      } catch (error) {
        logger.warn("[orphanBlobSweep] Listing storage failed; the run stops here", { error });
        return result;
      } finally {
        clearTimeout(timer);
      }
      cursor = page.hasMore ? page.cursor : undefined;
      result.listed += page.blobs.length;

      const cutoff = now() - source.minAgeMs;
      const candidates = page.blobs.filter(
        (blob) => source.shape.test(blob.pathname) && new Date(blob.uploadedAt).getTime() < cutoff,
      );
      if (candidates.length === 0) continue;
      const referenced = await referencedOnPage(db, candidates);
      for (const blob of candidates) {
        if (referenced.has(blob)) {
          result.kept += 1;
          continue;
        }
        if (now() >= deadline) return result;
        try {
          const outcome = await deleteUnlessReferenced(db, blob, del);
          result[outcome] += 1;
        } catch (error) {
          result.failed += 1;
          logger.warn("[orphanBlobSweep] Couldn't delete an unregistered upload (tried again tomorrow)", {
            error,
            pathname: blob.pathname,
          });
        }
      }
    } while (cursor);
  }

  result.finished = true;
  return result;
}

/**
 * Daily at 06:25 UTC, a free slot in the cadence map (inngest-functions.ts),
 * one step: one execution a day. SEC: the step output is counts only.
 */
export const orphanBlobSweep = inngest.createFunction(
  {
    id: "orphan-blob-sweep",
    name: "Orphan Blob Sweep",
    singleton: { mode: "skip" },
  },
  { cron: "25 6 * * *" },
  async ({ step }) => {
    // Review of R5-security M1: the usage log's old rows go in this same step,
    // so they cost no new function and no new execution.
    const summary = await step.run("sweep", async () => {
      const usageEventsPruned = await pruneUsageEvents(new Date());
      return { ...(await sweepOrphanBlobs()), usageEventsPruned };
    });
    logger.info("[Inngest] Unregistered uploads swept", summary);
    return summary;
  },
);
