"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  ConnectionStatus,
  ConnectionsResponse,
} from "@/lib/connectionsDto";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";
import { SIGNED_OUT_ERROR } from "@/lib/signedOutMessage";

/**
 * R26 LL3: the hook says its own sentences, never the browser's ("Failed to
 * fetch", "Load failed", "Unexpected token '<'..."), which Create showed in
 * front of its own line.
 */
export const CONNECTIONS_OFFLINE_TEXT =
  "We couldn't reach Vibe Socials to load your connections. Check your connection and try again.";
export const CONNECTIONS_FAILED_TEXT = "We couldn't load your connections. Try again in a moment.";

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
      const response = await fetchOrNoAnswer("/api/connections");
      if (!response.ok) {
        setError(response.status === 401 ? SIGNED_OUT_ERROR : CONNECTIONS_FAILED_TEXT);
        return;
      }
      const data = (await response.json()) as Partial<ConnectionsResponse> | null;
      if (!Array.isArray(data?.connections)) {
        setError(CONNECTIONS_FAILED_TEXT);
        return;
      }
      setConnections(data.connections);
    } catch (err: unknown) {
      setError(isNoAnswer(err) ? CONNECTIONS_OFFLINE_TEXT : CONNECTIONS_FAILED_TEXT);
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
