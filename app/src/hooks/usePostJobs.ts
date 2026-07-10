"use client";

import { useCallback, useEffect, useState } from "react";

import type { PostJobDTO, PostsResponse } from "@/lib/postsDto";

export interface UsePostJobsResult {
  jobs: PostJobDTO[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Fetches the current user's post jobs from `GET /api/posts`. Shared by the
 * dashboard's recent-activity preview and the full activity view.
 */
export function usePostJobs(): UsePostJobsResult {
  const [jobs, setJobs] = useState<PostJobDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/posts");
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? "Please sign in to view your posts."
            : "Failed to load posts.",
        );
      }
      const data: PostsResponse = await response.json();
      setJobs(data.jobs);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load posts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { jobs, loading, error, reload: load };
}
