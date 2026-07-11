import { describe, expect, it } from "vitest";

import { summarizeYouTubeMetrics } from "@/lib/metricsSummary";
import type { PostJobDTO, PostJobResultDTO, PostMetricDTO } from "@/lib/postsDto";

function metric(partial: Partial<PostMetricDTO>): PostMetricDTO {
  return {
    views: null,
    likes: null,
    comments: null,
    shares: null,
    fetchedAt: "2026-07-10T00:00:00.000Z",
    ...partial,
  };
}

function result(partial: Partial<PostJobResultDTO>): PostJobResultDTO {
  return {
    platform: "youtube",
    status: "success",
    externalPostId: "vid",
    errorMessage: null,
    metric: null,
    ...partial,
  };
}

function job(results: PostJobResultDTO[]): PostJobDTO {
  return {
    id: "job",
    status: "completed",
    createdAt: "2026-07-10T00:00:00.000Z",
    scheduledFor: null,
    caption: "c",
    results,
  };
}

describe("summarizeYouTubeMetrics", () => {
  it("sums views/likes/comments across YouTube posts with metrics", () => {
    const jobs = [
      job([result({ externalPostId: "a", metric: metric({ views: 100, likes: 10, comments: 1 }) })]),
      job([result({ externalPostId: "b", metric: metric({ views: 50, likes: 5, comments: 2 }) })]),
    ];
    expect(summarizeYouTubeMetrics(jobs)).toEqual({
      totalViews: 150,
      totalLikes: 15,
      totalComments: 3,
      trackedVideos: 2,
    });
  });

  it("treats null counts as 0 in the sum but still counts the video as tracked", () => {
    const jobs = [
      job([result({ externalPostId: "a", metric: metric({ views: 100, likes: null, comments: null }) })]),
    ];
    expect(summarizeYouTubeMetrics(jobs)).toEqual({
      totalViews: 100,
      totalLikes: 0,
      totalComments: 0,
      trackedVideos: 1,
    });
  });

  it("dedupes by externalPostId so the same video is never double-counted", () => {
    const shared = metric({ views: 100, likes: 10, comments: 1 });
    const jobs = [
      job([result({ externalPostId: "dupe", metric: shared })]),
      job([result({ externalPostId: "dupe", metric: shared })]),
    ];
    expect(summarizeYouTubeMetrics(jobs)).toEqual({
      totalViews: 100,
      totalLikes: 10,
      totalComments: 1,
      trackedVideos: 1,
    });
  });

  it("ignores non-YouTube results, YouTube results without a metric, and results without an externalPostId", () => {
    const jobs = [
      // Non-YouTube, even with a (hypothetical) metric — ignored.
      job([result({ platform: "tiktok", externalPostId: "t1", metric: metric({ views: 999 }) })]),
      // YouTube but no metric yet — ignored (not tracked).
      job([result({ externalPostId: "y1", metric: null })]),
      // YouTube metric but no externalPostId — ignored.
      job([result({ externalPostId: null, metric: metric({ views: 5 }) })]),
      // The one that counts.
      job([result({ externalPostId: "y2", metric: metric({ views: 7, likes: 3, comments: 2 }) })]),
    ];
    expect(summarizeYouTubeMetrics(jobs)).toEqual({
      totalViews: 7,
      totalLikes: 3,
      totalComments: 2,
      trackedVideos: 1,
    });
  });

  it("returns an all-zero summary with 0 tracked videos for no jobs", () => {
    expect(summarizeYouTubeMetrics([])).toEqual({
      totalViews: 0,
      totalLikes: 0,
      totalComments: 0,
      trackedVideos: 0,
    });
  });
});
