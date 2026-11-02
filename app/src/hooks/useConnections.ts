"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  ConnectionStatus,
  ConnectionsResponse,
} from "@/lib/connectionsDto";

export interface UseConnectionsResult {
  connections: ConnectionStatus[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Fetches per-platform connection status from `GET /api/connections` for the
 * dashboard's connection-health widget.
 */
export function useConnections(): UseConnectionsResult {
  const [connections, setConnections] = useState<ConnectionStatus[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/connections");
      if (!response.ok) {
        throw new Error("Failed to load connections.");
      }
      const data: ConnectionsResponse = await response.json();
      setConnections(data.connections);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to load connections.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-mount effect; pre-existing pattern newly flagged by react-hooks 7.1 (required by eslint-config-next 16.4)
    load();
  }, [load]);

  return { connections, loading, error, reload: load };
}
