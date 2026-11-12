import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient, type Platform } from "@prisma/client";
import bcrypt from "bcryptjs";

import { generateInviteToken } from "../../src/lib/inviteToken";
import { sealSecret } from "../../src/lib/tokenCrypto";

/**
 * UI audit: the made-up business the screenshots show, written straight into
 * the CI test database. Every name, address and token here is a dummy.
 *
 * Safety: refuses any database that is not on localhost or 127.0.0.1, and
 * builds its own PrismaClient on that URL (never src/lib/db.ts).
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const AUDIT_PASSWORD = "audit-password-not-real-1";

export const MAIN_EMAILS = {
  owner: "owner.harborsurf@example.test",
  member: "member.harborsurf@example.test",
  visitor: "visitor.harborsurf@example.test",
} as const;

export const BILLING_EMAILS = {
  trialNew: "trial.new.harborsurf@example.test",
  trialEnding: "trial.ending.harborsurf@example.test",
  trialEnded: "trial.ended.harborsurf@example.test",
  unconfirmed: "unconfirmed.harborsurf@example.test",
  starter: "owner.startersurf@example.test",
  growth: "owner.growthsurf@example.test",
} as const;

export function auditDatabaseUrl(): string {
  const url = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  for (const candidate of [process.env.E2E_DATABASE_URL, process.env.DATABASE_URL]) {
    if (!candidate) continue;
    let host = "";
    try {
      host = new URL(candidate).hostname;
    } catch {
      throw new Error("UI audit: the database URL does not parse; refusing to run.");
    }
    if (host !== "localhost" && host !== "127.0.0.1") {
      throw new Error(`UI audit: the database is on "${host}", not localhost or 127.0.0.1; refusing to run.`);
    }
  }
  if (!url) throw new Error("UI audit: no E2E_DATABASE_URL or DATABASE_URL; refusing to run.");
  return url;
}

export function auditPrisma(): PrismaClient {
  return new PrismaClient({ datasourceUrl: auditDatabaseUrl() });
}

/** Removes everything an earlier audit run seeded for these addresses. Test database only. */
async function removeEarlierRun(prisma: PrismaClient, emails: readonly string[]): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { in: [...emails] } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    const memberships = await prisma.workspaceMember.findMany({ where: { userId: { in: ids } }, select: { workspaceId: true } });
    await prisma.workspace.deleteMany({ where: { id: { in: [...new Set(memberships.map((m) => m.workspaceId))] } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  // Login and route throttles from an earlier run on the same runner IP.
  await prisma.rateLimitEntry.deleteMany({});
}

async function createUser(
  prisma: PrismaClient,
  email: string,
  name: string,
  passwordHash: string,
  extra: Partial<Prisma.UserCreateInput> = {},
) {
  return prisma.user.create({
    data: { email, name, passwordHash, emailVerifiedAt: new Date(Date.now() - 90 * DAY), ...extra },
  });
}

/** A workspace and its first membership, both dated `createdAt`. */
async function createWorkspace(
  prisma: PrismaClient,
  ownerId: string,
  name: string,
  createdAt: Date,
  extra: Partial<Prisma.WorkspaceCreateInput> = {},
) {
  const workspace = await prisma.workspace.create({ data: { name, createdAt, ...extra } });
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: ownerId, role: "owner", createdAt } });
  return workspace;
}

export interface SeededMedia {
  photos: string[]; // public addresses in the file store double
  video: { url: string; mimeType: string } | null;
  logo: string;
}

export interface MainSeed {
  ownerId: string;
  memberId: string;
  visitorId: string;
  mainId: string;
  mainName: string;
  emptyId: string;
  pausedId: string;
  pendingConnectionId: string;
}

const CONNECTIONS: { platform: Platform; accountIdentifier: string; metadata: Prisma.InputJsonValue; needsReconnect?: boolean }[] = [
  { platform: "tiktok", accountIdentifier: "harborsurfco", metadata: { username: "harborsurfco" } },
  { platform: "youtube", accountIdentifier: "UC-audit-dummy-channel", metadata: { username: "Harbor Surf Co" } },
  { platform: "x", accountIdentifier: "harborsurfco", metadata: { username: "harborsurfco" } },
  {
    platform: "linkedin",
    accountIdentifier: "audit-dummy-member",
    metadata: { username: "Harbor Surf Co", organizations: [{ id: 1000001, name: "Harbor Surf Co" }] },
    needsReconnect: true,
  },
  {
    platform: "instagram",
    accountIdentifier: "17800000000000001",
    metadata: { username: "harborsurfco", pageId: "100000000000001" },
  },
  {
    platform: "google_business_profile",
    accountIdentifier: "accounts/audit-dummy",
    metadata: {
      locationName: "locations/4815162342",
      locationTitle: "Harbor Surf Co, Cocoa Beach",
      newReviewUri: "https://g.page/r/AUDIT-DUMMY-LINK/review",
      newReviewUriFor: "locations/4815162342",
    },
  },
  { platform: "facebook_page", accountIdentifier: "100000000000001", metadata: { pageName: "Harbor Surf Co" } },
  {
    platform: "pinterest",
    accountIdentifier: "harborsurfco",
    metadata: { username: "harborsurfco", accountId: "audit-dummy", accountType: "BUSINESS", boardId: "900000000000000001", boardName: "Lessons and camps" },
  },
];

const LONG_ERROR =
  "YouTube refused the upload: the video was processed but rejected with \"uploadLimitExceeded\". " +
  "The channel has reached the number of videos it may upload in 24 hours. This usually clears by itself " +
  "within a day; YouTube does not say exactly when. Nothing was published to YouTube. Retry YouTube " +
  "tomorrow from this page, or upload the video in YouTube Studio yourself. If this keeps happening, " +
  "check in YouTube Studio that the channel is verified, because unverified channels get a lower daily " +
  "limit and cannot upload videos longer than 15 minutes. Request id: audit-dummy-0000-0000-0000-000000000000.";

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** A tomorrow-or-later time on a round hour, `days` from now. */
function future(now: Date, days: number, hourUtc: number): Date {
  const d = new Date(now.getTime() + days * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

export async function seedMain(prisma: PrismaClient, media: SeededMedia): Promise<MainSeed> {
  await removeEarlierRun(prisma, Object.values(MAIN_EMAILS));
  const now = new Date();
  const run = randomUUID().slice(0, 8);
  const passwordHash = await bcrypt.hash(AUDIT_PASSWORD, 10);

  const owner = await createUser(prisma, MAIN_EMAILS.owner, "Maya Ortiz", passwordHash);
  const member = await createUser(prisma, MAIN_EMAILS.member, "Jordan Lee", passwordHash);
  const visitor = await createUser(prisma, MAIN_EMAILS.visitor, "Sam Rivera", passwordHash);

  const mainName = "Harbor Surf Co";
  const main = await createWorkspace(prisma, owner.id, mainName, new Date(now.getTime() - 120 * DAY), {
    companyWebsite: "https://harborsurf.example",
    defaultHashtags: "#HarborSurfCo #CocoaBeach #LearnToSurf",
    requireApproval: true,
    googleButtonType: "BOOK",
    googleButtonUrl: "https://harborsurf.example/book",
    brandVoice: "Friendly and plain, like a coach on the beach: short sentences, no hype, always say when and where.",
    brandVoiceExamples: [
      "Small, clean waves this Saturday. Lessons at 8 and 10, boards and wetsuits included. Book on our site.",
      "Week 2 of kids camp is done. Twelve new surfers stood up on day one. Thank you, parents!",
    ].join("\n"),
    trackWebsiteLinks: true,
    postingSlots: [
      { day: 2, time: "09:00" },
      { day: 4, time: "17:30" },
      { day: 6, time: "08:00" },
    ],
    logoUrl: media.logo,
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: main.id, userId: member.id, role: "member", createdAt: new Date(now.getTime() - 30 * DAY) },
  });
  // Everyone who registers gets a personal workspace; the member and the visitor too.
  await createWorkspace(prisma, member.id, "Jordan Lee's workspace", new Date(now.getTime() - 31 * DAY));
  await createWorkspace(prisma, visitor.id, "Sam Rivera's workspace", new Date(now.getTime() - 3 * DAY));

  const empty = await createWorkspace(prisma, owner.id, "Dune Road Cafe", new Date(now.getTime() - 10 * DAY));
  const paused = await createWorkspace(prisma, owner.id, "Pier 9 Rentals", new Date(now.getTime() - 20 * DAY), {
    pausedAt: new Date(now.getTime() - 2 * DAY),
    pausedReason: "Paused while the account details are checked. Write to support to have it resumed.",
  });
  await prisma.adminAction.create({
    data: {
      operatorUserId: owner.id,
      operatorEmail: MAIN_EMAILS.owner,
      workspaceId: paused.id,
      workspaceName: paused.name,
      action: "pause",
      detail: { old: null, new: paused.pausedReason },
      createdAt: new Date(now.getTime() - 2 * DAY),
    },
  });

  // Connections: all eight on the main workspace, LinkedIn needing a reconnect.
  const connectionIds = new Map<Platform, string>();
  for (const c of CONNECTIONS) {
    const row = await prisma.socialConnection.create({
      data: {
        userId: owner.id,
        workspaceId: main.id,
        platform: c.platform,
        accessToken: sealSecret("audit-dummy-access-token"),
        accountIdentifier: c.accountIdentifier,
        metadata: c.metadata,
        needsReconnect: c.needsReconnect ?? false,
        ...(c.needsReconnect
          ? { lastRefreshErrorCode: "LINKEDIN_RECONNECT_REQUIRED", refreshFailedAt: new Date(now.getTime() - DAY) }
          : {}),
        createdAt: new Date(now.getTime() - 100 * DAY),
      },
    });
    connectionIds.set(c.platform, row.id);
  }
  // The paused workspace has accounts too, so its Create page shows the form (and refuses).
  for (const platform of ["x", "facebook_page"] as const) {
    await prisma.socialConnection.create({
      data: {
        userId: owner.id,
        workspaceId: paused.id,
        platform,
        accessToken: sealSecret("audit-dummy-access-token"),
        accountIdentifier: platform === "x" ? "pier9rentals" : "100000000000009",
        metadata: platform === "x" ? { username: "pier9rentals" } : { pageName: "Pier 9 Rentals" },
      },
    });
  }

  // A connect that found several Facebook Pages and waits for a choice (what the callback writes).
  const pending = await prisma.pendingConnection.create({
    data: {
      workspaceId: main.id,
      userId: owner.id,
      platform: "facebook_page",
      payload: sealSecret(
        JSON.stringify({
          platform: "facebook_page",
          expiresAt: new Date(now.getTime() + 50 * DAY).toISOString(),
          pages: [
            { id: "100000000000001", name: "Harbor Surf Co", accessToken: "audit-dummy-page-token-1" },
            { id: "100000000000002", name: "Harbor Surf Co Kids Camp", accessToken: "audit-dummy-page-token-2" },
            { id: "100000000000003", name: "Cocoa Beach Surf Report", accessToken: "audit-dummy-page-token-3" },
          ],
        }),
      ),
      expiresAt: new Date(now.getTime() + 6 * HOUR),
    },
  });

  // Media library: six photos and one video, the first photo described.
  const photoNames = [
    "saturday-lesson.jpg",
    "new-boards.jpg",
    "kids-camp.jpg",
    "sunrise-session.jpg",
    "wax-and-fins.jpg",
    "team-photo.jpg",
  ];
  const photoIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const item = await prisma.mediaItem.create({
      data: {
        userId: owner.id,
        workspaceId: main.id,
        storageLocation: media.photos[i],
        originalFilename: photoNames[i],
        mimeType: "image/jpeg",
        sizeBytes: 182_000 + i * 9_731,
        baseCaption: "",
        altText:
          i === 0
            ? "Six students in a line on soft-top boards at the water's edge, an instructor in a red rash guard in front of them."
            : null,
        createdAt: new Date(now.getTime() - (45 - i * 6) * DAY),
        lastUsedAt: new Date(now.getTime() - (10 - i) * DAY),
      },
    });
    photoIds.push(item.id);
  }
  const videoId = media.video
    ? (
        await prisma.mediaItem.create({
          data: {
            userId: owner.id,
            workspaceId: main.id,
            storageLocation: media.video.url,
            originalFilename: media.video.mimeType === "video/mp4" ? "lesson-clip.mp4" : "lesson-clip.webm",
            mimeType: media.video.mimeType,
            sizeBytes: 2_450_000,
            baseCaption: "",
            createdAt: new Date(now.getTime() - 34 * DAY),
            lastUsedAt: new Date(now.getTime() - 9 * DAY),
          },
        })
      ).id
    : null;

  type ResultSpec = {
    platform: Platform;
    ok: boolean;
    errorCode?: string;
    errorMessage?: string;
    metric?: { views?: number; likes?: number; comments?: number; shares?: number; clicks?: number; saves?: number };
  };

  let externalCounter = 0;
  async function post(args: {
    userId?: string;
    mediaItemId: string | null;
    extraPhotos?: string[];
    status: Prisma.PostJobCreateInput["status"];
    caption: string;
    createdAt: Date;
    scheduledFor?: Date | null;
    publishMetadata?: Prisma.InputJsonValue;
    perPlatformOverrides?: Prisma.InputJsonValue;
    seriesId?: string;
    submittedForApprovalAt?: Date;
    clientApprovedAt?: Date;
    clientChangeRequestedAt?: Date;
    clientNote?: string;
    results?: ResultSpec[];
  }) {
    const job = await prisma.postJob.create({
      data: {
        userId: args.userId ?? owner.id,
        workspaceId: main.id,
        mediaItemId: args.mediaItemId,
        status: args.status,
        baseCaption: args.caption,
        scheduledFor: args.scheduledFor ?? null,
        publishMetadata: args.publishMetadata ?? Prisma.JsonNull,
        perPlatformOverrides: args.perPlatformOverrides ?? Prisma.JsonNull,
        seriesId: args.seriesId ?? null,
        submittedForApprovalAt: args.submittedForApprovalAt ?? null,
        clientApprovedAt: args.clientApprovedAt ?? null,
        clientChangeRequestedAt: args.clientChangeRequestedAt ?? null,
        clientNote: args.clientNote ?? null,
        createdAt: args.createdAt,
      },
    });
    if (args.mediaItemId && args.extraPhotos && args.extraPhotos.length > 0) {
      const all = [args.mediaItemId, ...args.extraPhotos];
      for (let position = 0; position < all.length; position++) {
        await prisma.postJobMedia.create({ data: { postJobId: job.id, mediaItemId: all[position], position } });
      }
    }
    for (const r of args.results ?? []) {
      externalCounter += 1;
      const externalPostId = r.ok ? `audit-${run}-${r.platform}-${externalCounter}` : null;
      const finishedAt = new Date(args.createdAt.getTime() + 4 * 60 * 1000);
      const result = await prisma.postJobResult.create({
        data: {
          postJobId: job.id,
          platform: r.platform,
          socialConnectionId: connectionIds.get(r.platform) ?? null,
          status: r.ok ? "success" : "failed",
          externalPostId,
          errorCode: r.ok ? null : (r.errorCode ?? "PUBLISH_FAILED"),
          errorMessage: r.ok ? null : (r.errorMessage ?? "The platform refused the post."),
          workspaceId: main.id,
          createdAt: args.createdAt,
          updatedAt: finishedAt,
        },
      });
      if (r.ok && r.metric && externalPostId) {
        await prisma.postMetric.create({
          data: {
            userId: owner.id,
            workspaceId: main.id,
            platform: r.platform,
            externalPostId,
            postJobResultId: result.id,
            fetchedAt: new Date(now.getTime() - 2 * HOUR),
            ...r.metric,
          },
        });
      }
    }
    return job;
  }

  const ago = (days: number, hours = 0) => new Date(now.getTime() - days * DAY - hours * HOUR);
  const [p0, p1, p2, p3, p4, p5] = photoIds;

  // Eight published over the last 40 days.
  await post({
    mediaItemId: p1, status: "completed", createdAt: ago(38),
    caption: "New boards just landed: 9'0\" soft tops for first-timers. Come try one this weekend.",
    results: [
      { platform: "instagram", ok: true, metric: { likes: 1, comments: 0 } },
      { platform: "facebook_page", ok: true, metric: { likes: 14, comments: 2, shares: 1 } },
    ],
  });
  if (videoId) {
    await post({
      mediaItemId: videoId, status: "completed", createdAt: ago(33),
      caption: "Pop-up drill in 20 seconds. Practice it on the sand before your first lesson.",
      results: [
        { platform: "youtube", ok: true, metric: { views: 4821, likes: 312, comments: 27 } },
        { platform: "tiktok", ok: true, metric: { views: 12870, likes: 1043, comments: 58, shares: 21 } },
      ],
    });
  }
  await post({
    mediaItemId: null, status: "completed", createdAt: ago(27),
    caption: "Surf report: 2-3 ft and offshore until noon. Lessons at 8 and 10 still have spots.",
    results: [
      { platform: "x", ok: true, metric: { likes: 3, comments: 1 } },
      { platform: "linkedin", ok: true, metric: { clicks: 1, likes: 3 } },
    ],
  });
  await post({
    mediaItemId: p2, status: "completed", createdAt: ago(21),
    caption: "Kids camp week 2 is a wrap. Twelve new surfers stood up on day one.",
    results: [
      { platform: "google_business_profile", ok: true },
      { platform: "pinterest", ok: true, metric: { saves: 1, clicks: 14 } },
    ],
  });
  await post({
    mediaItemId: p3, status: "completed", createdAt: ago(15),
    caption: "Sunrise session this morning. Glassy, small, and nobody else out.",
    results: [
      { platform: "instagram", ok: true, metric: { likes: 2304, comments: 141 } },
      { platform: "facebook_page", ok: true, metric: { likes: 1187, comments: 66, shares: 240 } },
    ],
  });
  if (videoId) {
    await post({
      mediaItemId: videoId, status: "completed", createdAt: ago(9),
      caption: "How to carry your board without hitting anyone. A 15-second lesson.",
      results: [{ platform: "youtube", ok: true, metric: { views: 1, likes: 0, comments: 0 } }],
    });
  }
  await post({
    mediaItemId: p4, status: "completed", createdAt: ago(5),
    caption: "Wax, fins and leashes are back in stock in the shop corner.",
    perPlatformOverrides: { x: "Wax, fins and leashes are back in stock. Shop corner, open 7-6." },
    results: [
      { platform: "linkedin", ok: true, metric: { clicks: 1203, likes: 87, comments: 9 } },
      { platform: "x", ok: true, metric: { likes: 1, comments: 0 } },
    ],
  });
  await post({
    mediaItemId: p0, status: "completed", createdAt: ago(2),
    caption: "Saturday lesson crew. Book the next one on our site.",
    results: [
      { platform: "instagram", ok: true, metric: { likes: 1, comments: 1 } },
      { platform: "facebook_page", ok: true, metric: { likes: 38, comments: 4 } },
      { platform: "google_business_profile", ok: true },
    ],
  });

  // Two failed today, one with a long platform message, and one partly failed.
  await post({
    mediaItemId: p5, status: "failed", createdAt: ago(0, 3),
    caption: "Meet the team: four instructors, all certified, all local.",
    results: [
      {
        platform: "instagram",
        ok: false,
        errorCode: "INSTAGRAM_MEDIA_FETCH_FAILED",
        errorMessage: "Instagram couldn't download the photo. Try again in a few minutes.",
      },
    ],
  });
  await post({
    mediaItemId: videoId ?? p5, status: "failed", createdAt: ago(0, 1),
    caption: "Lesson clip: from paddling to standing in one wave.",
    results: [{ platform: "youtube", ok: false, errorCode: "YOUTUBE_QUOTA_EXCEEDED", errorMessage: LONG_ERROR }],
  });
  await post({
    mediaItemId: p3, status: "completed", createdAt: ago(0, 2),
    caption: "Board rental by the hour is open again from 7 am.",
    results: [
      { platform: "facebook_page", ok: true, metric: { likes: 6 } },
      { platform: "x", ok: true, metric: { likes: 2 } },
      {
        platform: "linkedin",
        ok: false,
        errorCode: "LINKEDIN_RECONNECT_REQUIRED",
        errorMessage: "LinkedIn says the connection has expired. Reconnect LinkedIn in Settings, then retry.",
      },
    ],
  });

  // Scheduled: several photos, a Story, a text post, one the client approved.
  await post({
    mediaItemId: p0, extraPhotos: [p1, p2], status: "scheduled", createdAt: ago(1),
    scheduledFor: future(now, 2, 14),
    caption: "Three photos from this week: lessons, new boards and camp. Which one is your favourite?",
    publishMetadata: { targetPlatforms: ["instagram", "facebook_page", "x", "linkedin"] },
  });
  await post({
    mediaItemId: p4, status: "scheduled", createdAt: ago(1),
    scheduledFor: future(now, 3, 13),
    caption: "Shop corner restock.",
    publishMetadata: { targetPlatforms: ["instagram"], instagram: { placement: "story" } },
  });
  await post({
    mediaItemId: null, status: "scheduled", createdAt: ago(1),
    scheduledFor: future(now, 4, 12),
    caption: "Reminder: lessons are cancelled on Sunday because of the storm. We'll call everyone who booked.",
    publishMetadata: { targetPlatforms: ["x", "linkedin", "facebook_page", "google_business_profile"] },
  });
  await post({
    mediaItemId: p5, status: "scheduled", createdAt: ago(2),
    scheduledFor: future(now, 6, 15),
    caption: "Meet the team, take two: four instructors, all certified, all local.",
    publishMetadata: { targetPlatforms: ["instagram", "facebook_page"] },
    clientApprovedAt: ago(0, 20),
  });
  // A repeat series of four, weekly.
  const seriesId = randomUUID();
  for (let i = 0; i < 4; i++) {
    await post({
      mediaItemId: p2, status: "scheduled", createdAt: ago(3),
      scheduledFor: future(now, 5 + i * 7, 13),
      caption: "Kids camp sign-ups are open. Mornings, ages 7 to 14, boards included.",
      publishMetadata: { targetPlatforms: ["instagram", "facebook_page"] },
      seriesId,
    });
  }

  // Drafts, a member's post waiting for approval, a client's change request.
  await post({ mediaItemId: p1, status: "draft", createdAt: ago(4), caption: "Draft: summer camp dates and prices." });
  await post({ mediaItemId: null, status: "draft", createdAt: ago(6), caption: "Draft: gift cards for the holidays?" });
  await post({
    userId: member.id, mediaItemId: p3, status: "draft", createdAt: ago(0, 5),
    scheduledFor: future(now, 3, 22),
    submittedForApprovalAt: ago(0, 5),
    caption: "Sunset session on Friday at 6. Bring a friend, second lesson half price.",
    publishMetadata: { targetPlatforms: ["instagram", "facebook_page"] },
  });
  await post({
    mediaItemId: p1, status: "draft", createdAt: ago(2),
    scheduledFor: future(now, 2, 21),
    clientChangeRequestedAt: ago(0, 6),
    clientNote: "Can we use the photo with the orange boards instead? And please mention the Saturday lesson at 8.",
    caption: "Rent a board for the weekend: Friday to Sunday for the price of two days.",
    publishMetadata: { targetPlatforms: ["instagram", "facebook_page", "google_business_profile"] },
  });

  // Google listing numbers for the last 70 days.
  const today = utcMidnight(now);
  const rows: Prisma.LocationMetricDailyCreateManyInput[] = [];
  for (let d = 70; d >= 1; d--) {
    const day = new Date(today.getTime() - d * DAY);
    const wave = Math.sin(d / 5) * 0.3 + 1;
    const weekend = [0, 6].includes(day.getUTCDay()) ? 1.4 : 1;
    rows.push({
      workspaceId: main.id,
      locationName: "locations/4815162342",
      day,
      searchViews: Math.round(120 * wave * weekend),
      mapsViews: Math.round(70 * wave * weekend),
      calls: Math.round(3 * wave * weekend) % 7,
      directionRequests: Math.round(5 * wave * weekend),
      websiteClicks: Math.round(9 * wave * weekend),
      fetchedAt: new Date(day.getTime() + 2 * DAY),
    });
  }
  await prisma.locationMetricDaily.createMany({ data: rows });

  // Near one limit: posts today one under the workspace's daily limit (the
  // count the app enforces: by scheduledFor, else createdAt, drafts and
  // cancelled posts left out).
  const start = today;
  const end = new Date(today.getTime() + DAY);
  const postsToday = await prisma.postJob.count({
    where: {
      workspaceId: main.id,
      status: { notIn: ["draft", "cancelled"] },
      OR: [
        { scheduledFor: { gte: start, lt: end } },
        { scheduledFor: null, createdAt: { gte: start, lt: end } },
      ],
    },
  });
  await prisma.workspace.update({ where: { id: main.id }, data: { limitPostsPerDay: postsToday + 1 } });

  return {
    ownerId: owner.id,
    memberId: member.id,
    visitorId: visitor.id,
    mainId: main.id,
    mainName,
    emptyId: empty.id,
    pausedId: paused.id,
    pendingConnectionId: pending.id,
  };
}

/** The raw tokens of a paying workspace's three client links, for /u, /v and /c. */
export interface PaidLinks {
  upload: string;
  review: string;
  connect: string;
}

export interface PaidSeed {
  workspaceId: string;
  links: PaidLinks;
}

export interface BillingSeed {
  trialNewId: string;
  trialEndingId: string;
  trialEndedId: string;
  unconfirmedId: string;
  starter: PaidSeed;
  growth: PaidSeed;
}

/** Same as CONNECT_LINK_TTL_MS in src/lib/connectLink.ts (not imported: it pulls in "@/" paths). */
const CONNECT_LINK_TTL_MS = 14 * DAY;

/** The billing pass: four accounts in different trial states, and two paying owners (A2). */
export async function seedBilling(prisma: PrismaClient, media: { logo: string }): Promise<BillingSeed> {
  await removeEarlierRun(prisma, Object.values(BILLING_EMAILS));
  const now = new Date();
  const passwordHash = await bcrypt.hash(AUDIT_PASSWORD, 10);

  async function trialAccount(
    email: string,
    name: string,
    workspaceName: string,
    startedDaysAgo: number,
    endsInDays: number,
    verified = true,
    extra: Partial<Prisma.WorkspaceCreateInput> = {},
  ) {
    const user = await createUser(prisma, email, name, passwordHash, {
      trialStartedAt: new Date(now.getTime() - startedDaysAgo * DAY),
      ...(verified ? {} : { emailVerifiedAt: null }),
    });
    const workspace = await createWorkspace(prisma, user.id, workspaceName, new Date(now.getTime() - startedDaysAgo * DAY), {
      trialEndsAt: new Date(now.getTime() + endsInDays * DAY),
      billingExempt: false,
      companyWebsite: "https://harborsurf.example",
      ...extra,
    });
    await prisma.socialConnection.create({
      data: {
        userId: user.id,
        workspaceId: workspace.id,
        platform: "x",
        accessToken: sealSecret("audit-dummy-access-token"),
        accountIdentifier: "harborsurfco",
        metadata: { username: "harborsurfco" },
      },
    });
    return { userId: user.id, workspaceId: workspace.id };
  }

  /**
   * An owner paying for `plan`: the trial ended 56 days ago and a monthly
   * subscription is active. The plan columns are what the Stripe webhook
   * writes for an active subscription (server/billing/subscriptionSync.ts):
   * plan from the price, Stripe's status, the item's period end, no planned
   * end, the subscription id, and the customer bound by checkout. Everything a
   * gated place reads is filled in, so each one shows its plan's state.
   */
  async function payingAccount(plan: "starter" | "growth", email: string, name: string, workspaceName: string): Promise<PaidSeed> {
    const { userId, workspaceId } = await trialAccount(email, name, workspaceName, 70, -56, true, {
      plan,
      planStatus: "active",
      currentPeriodEnd: new Date(now.getTime() + 18 * DAY),
      planEndsAt: null,
      stripeSubscriptionId: `sub_dummy_ui_audit_${plan}`,
      stripeCustomerId: `cus_dummy_ui_audit_${plan}`,
      // Brand voice: the Settings section and its plan line.
      brandVoice: "Warm and plain, like a coach on the beach: short sentences, no hype, always say when and where.",
      brandVoiceExamples: "Small, clean waves this Saturday. Lessons at 8 and 10, boards and wetsuits included.",
      // The report logo: the Settings row and the client's report.
      logoUrl: media.logo,
    });
    // Review alerts switched on (the default, written out so the picture does not depend on it).
    await prisma.user.update({ where: { id: userId }, data: { notifyNewReviews: true, notifyMonthlyReport: true } });

    // Posts: published last month (the client's report shows last month by
    // default) and this week, so the dashboard shows "Working for clients?";
    // two scheduled, so the review link and the Queue have posts to show.
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 10, 14));
    const published = [
      { at: lastMonth, caption: "Kids camp week 2 is a wrap. Twelve new surfers stood up on day one.", likes: 41 },
      { at: new Date(now.getTime() - 3 * DAY), caption: "Surf report: 2-3 ft and offshore until noon. Lessons at 8 and 10.", likes: 12 },
    ];
    for (const [i, p] of published.entries()) {
      const job = await prisma.postJob.create({
        data: { userId, workspaceId, mediaItemId: null, status: "completed", baseCaption: p.caption, createdAt: p.at },
      });
      const externalPostId = `audit-${plan}-x-${i + 1}`;
      const result = await prisma.postJobResult.create({
        data: {
          postJobId: job.id,
          platform: "x",
          status: "success",
          externalPostId,
          workspaceId,
          createdAt: p.at,
          updatedAt: new Date(p.at.getTime() + 4 * 60 * 1000),
        },
      });
      await prisma.postMetric.create({
        data: {
          userId,
          workspaceId,
          platform: "x",
          externalPostId,
          postJobResultId: result.id,
          fetchedAt: new Date(now.getTime() - 2 * HOUR),
          likes: p.likes,
          comments: 2,
        },
      });
    }
    for (const [days, caption] of [
      [2, "Saturday lesson at 8: small, clean waves and a few spots left."],
      [5, "Board rental by the hour is open again from 7 am."],
    ] as const) {
      await prisma.postJob.create({
        data: {
          userId,
          workspaceId,
          mediaItemId: null,
          status: "scheduled",
          baseCaption: caption,
          scheduledFor: future(now, days, 14),
          publishMetadata: { targetPlatforms: ["x"] },
          createdAt: new Date(now.getTime() - DAY),
        },
      });
    }

    // The three client links, as the owner routes write them (token hash, the
    // sealed token, the owner as creator; the connect link with its platforms
    // and its 14 days). Written here because the routes refuse Starter, which
    // is the point: the pictures show what an owner whose links were made
    // before the plan changed sees.
    const upload = generateInviteToken();
    await prisma.workspaceUploadLink.create({
      data: { workspaceId, tokenHash: upload.hash, tokenSealed: sealSecret(upload.raw), createdById: userId },
    });
    const review = generateInviteToken();
    await prisma.workspaceReviewLink.create({
      data: { workspaceId, tokenHash: review.hash, tokenSealed: sealSecret(review.raw), createdById: userId },
    });
    const connect = generateInviteToken();
    await prisma.workspaceConnectLink.create({
      data: {
        workspaceId,
        tokenHash: connect.hash,
        tokenSealed: sealSecret(connect.raw),
        createdById: userId,
        platforms: ["instagram", "facebook_page", "x"],
        expiresAt: new Date(now.getTime() + CONNECT_LINK_TTL_MS),
      },
    });
    return { workspaceId, links: { upload: upload.raw, review: review.raw, connect: connect.raw } };
  }

  return {
    trialNewId: (await trialAccount(BILLING_EMAILS.trialNew, "Ana Brooks", "Harbor Surf Co", 0, 14)).workspaceId,
    trialEndingId: (await trialAccount(BILLING_EMAILS.trialEnding, "Ben Carter", "Harbor Surf Co", 12, 2)).workspaceId,
    trialEndedId: (await trialAccount(BILLING_EMAILS.trialEnded, "Cara Diaz", "Harbor Surf Co", 15, -1)).workspaceId,
    unconfirmedId: (await trialAccount(BILLING_EMAILS.unconfirmed, "Dev Patel", "Harbor Surf Co", 0, 14, false)).workspaceId,
    starter: await payingAccount("starter", BILLING_EMAILS.starter, "Eli Foster", "Starter Surf Co"),
    growth: await payingAccount("growth", BILLING_EMAILS.growth, "Gia Hayes", "Growth Surf Co"),
  };
}
