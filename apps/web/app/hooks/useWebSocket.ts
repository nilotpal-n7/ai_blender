/**
 * useWebSocket — React hook for WebSocket connection management.
 *
 * Provides a typed, auto-reconnecting WebSocket connection to the
 * orchestrator for real-time scene updates.
 *
 * Features:
 * - Auto-reconnect with exponential backoff (1s → 2s → 4s, max 30s)
 * - Typed message parsing with callbacks
 * - Connection state tracking
 * - Clean teardown on unmount
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ─── Types ──────────────────────────────────────────────────────────

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface WSMessage {
  type: string;
  payload: unknown;
}

export interface UseWebSocketOptions {
  /** Called when a scene:updated message arrives */
  onSceneUpdated?: (payload: {
    scene_id: string;
    usda: string;
    size: number;
  }) => void;
  /** Called when a job:status message arrives */
  onJobStatus?: (payload: {
    job_id: string;
    scene_id: string;
    status: string;
    result?: unknown;
  }) => void;
  /** Called when a layers:changed message arrives */
  onLayersChanged?: (payload: {
    scene_id: string;
    has_base_layer: boolean;
    base_layer_size: number;
    override_count: number;
    composed_size: number;
  }) => void;
  /** Called on any error */
  onError?: (error: string) => void;
}

// ─── Constants ──────────────────────────────────────────────────────

const WS_BASE_URL =
  process.env.NEXT_PUBLIC_WS_URL ||
  (typeof window !== "undefined"
    ? `ws://${window.location.hostname}:8080/api/v1`
    : "ws://localhost:8080/api/v1");

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// ─── Hook ───────────────────────────────────────────────────────────

export function useWebSocket(
  sceneId: string | null,
  options: UseWebSocketOptions = {}
) {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const connect = useCallback(
    (id: string) => {
      cleanup();
      setConnectionState("connecting");

      const url = `${WS_BASE_URL}/ws/scene/${id}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionState("connected");
        reconnectAttemptRef.current = 0;

        // Send subscribe message
        ws.send(
          JSON.stringify({ type: "scene:subscribe", payload: { scene_id: id } })
        );
      };

      ws.onmessage = (event) => {
        try {
          const msg: WSMessage = JSON.parse(event.data);
          const opts = optionsRef.current;

          switch (msg.type) {
            case "scene:updated":
              opts.onSceneUpdated?.(
                msg.payload as {
                  scene_id: string;
                  usda: string;
                  size: number;
                }
              );
              break;

            case "job:status":
              opts.onJobStatus?.(
                msg.payload as {
                  job_id: string;
                  scene_id: string;
                  status: string;
                }
              );
              break;

            case "layers:changed":
              opts.onLayersChanged?.(
                msg.payload as {
                  scene_id: string;
                  has_base_layer: boolean;
                  base_layer_size: number;
                  override_count: number;
                  composed_size: number;
                }
              );
              break;

            case "error":
              opts.onError?.(
                (msg.payload as { message?: string })?.message || "Unknown error"
              );
              break;
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        setConnectionState("disconnected");
        wsRef.current = null;

        // Auto-reconnect with exponential backoff
        const delay = Math.min(
          RECONNECT_BASE_MS * Math.pow(2, reconnectAttemptRef.current),
          RECONNECT_MAX_MS
        );
        reconnectAttemptRef.current++;

        reconnectTimerRef.current = setTimeout(() => {
          connect(id);
        }, delay);
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };
    },
    [cleanup]
  );

  // Connect when sceneId changes
  useEffect(() => {
    if (sceneId) {
      connect(sceneId);
    } else {
      cleanup();
      setConnectionState("disconnected");
    }

    return cleanup;
  }, [sceneId, connect, cleanup]);

  // Send a typed message to the server
  const sendMessage = useCallback((type: string, payload: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    }
  }, []);

  // Push an override via WebSocket (no HTTP needed)
  const pushOverride = useCallback(
    (overrideUsda: string) => {
      sendMessage("override:push", { override_usda: overrideUsda });
    },
    [sendMessage]
  );

  return {
    connectionState,
    sendMessage,
    pushOverride,
  };
}
