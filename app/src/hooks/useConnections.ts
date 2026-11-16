"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  ConnectionStatus,
  ConnectionsResponse,
} from "@/lib/connectionsDto";
import { fetchOrNoAnswer, isNoConnection } from "@/lib/requestNoAnswer";
import { SIGNED_OUT_ERROR } from "@/lib/signedOutMessage";
import { readWorkspaceRefusalText, withWorkspaceId } from "@/lib/workspaceChanged";

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
 *
 * R32 publishing L1: `workspaceId` is the workspace the page was drawn for,
 * and the read sends it, so a tab left on it after another tab switched gets
 * the switch sentence, not the other workspace's connections. Create calls it
 * without one for now (its call is outside R32's RR2 brief); the route then
 * reads the active workspace.
 */
export function useConnections(workspaceId?: string | null): UseConnectionsResult {
  const [connections, setConnections] = useState<ConnectionStatus[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchOrNoAnswer(withWorkspaceId("/api/connections", workspaceId ?? null));
      const refusal = await readWorkspaceRefusalText(response);
      if (refusal) {
        setError(refusal);
        return;
      }
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
      setError(isNoConnection(err) ? CONNECTIONS_OFFLINE_TEXT : CONNECTIONS_FAILED_TEXT);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-mount effect; pre-existing pattern newly flagged by react-hooks 7.1 (required by eslint-config-next 16.4)
    load();
  }, [load]);

  return { connections, loading, error, reload: load };
}
