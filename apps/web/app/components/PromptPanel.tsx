"use client";

import { useState, useRef, useCallback } from "react";
import {
  createScene,
  submitPrompt,
  pollJobUntilDone,
  getComposedState,
  getSceneLayers,
  type Job,
  type LayerInfo,
} from "../lib/api";

// ─── Job Status Labels ──────────────────────────────────────────────

const STATUS_CONFIG: Record<
  string,
  { label: string; color: string; glow: string }
> = {
  idle: {
    label: "Ready",
    color: "var(--success)",
    glow: "0 0 8px var(--success)",
  },
  queued: {
    label: "Queued...",
    color: "var(--warning)",
    glow: "0 0 8px var(--warning)",
  },
  processing: {
    label: "Generating...",
    color: "var(--accent-primary)",
    glow: "0 0 8px var(--accent-primary)",
  },
  completed: {
    label: "Done",
    color: "var(--success)",
    glow: "0 0 8px var(--success)",
  },
  failed: {
    label: "Failed",
    color: "var(--error)",
    glow: "0 0 8px var(--error)",
  },
};

/**
 * PromptPanel — Script/prompt editor sidebar.
 *
 * Connected to the orchestrator API:
 * 1. Creates a scene on first prompt submission
 * 2. Enqueues assembly jobs via POST /scene/:id/prompt
 * 3. Polls GET /job/:id/status until completion
 * 4. Fetches and displays composed USDA + layer info after completion
 */
export default function PromptPanel() {
  const [prompt, setPrompt] = useState("");
  const [jobStatus, setJobStatus] = useState<string>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [jobHistory, setJobHistory] = useState<
    { jobId: string; prompt: string; status: string }[]
  >([]);

  // USD Layer State
  const [layerInfo, setLayerInfo] = useState<LayerInfo | null>(null);
  const [composedUsda, setComposedUsda] = useState<string | null>(null);
  const [showUsda, setShowUsda] = useState(false);
  const [modelInfo, setModelInfo] = useState<{
    provider?: string;
    ai_model_used?: boolean;
    generation_time?: number;
  } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sceneIdRef = useRef<string | null>(null);

  const isProcessing = jobStatus === "queued" || jobStatus === "processing";
  const statusConfig = STATUS_CONFIG[jobStatus] || STATUS_CONFIG.idle;

  const fetchLayerData = useCallback(async (sceneId: string) => {
    try {
      const [layers, composed] = await Promise.all([
        getSceneLayers(sceneId),
        getComposedState(sceneId),
      ]);
      setLayerInfo(layers);
      setComposedUsda(composed.usda);
    } catch {
      // Layer data not available yet — not an error
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim() || isProcessing) return;

    setJobStatus("queued");
    setLastError(null);

    try {
      // Create scene on first submission
      if (!sceneIdRef.current) {
        const scene = await createScene("Untitled Scene");
        sceneIdRef.current = scene.scene_id;
      }

      // Submit prompt → get job ID
      const { job_id } = await submitPrompt(
        sceneIdRef.current,
        prompt.trim()
      );

      // Add to history
      setJobHistory((prev) => [
        { jobId: job_id, prompt: prompt.trim(), status: "queued" },
        ...prev,
      ]);

      // Poll until completion
      const finalJob = await pollJobUntilDone(job_id, (job: Job) => {
        setJobStatus(job.status);
        setJobHistory((prev) =>
          prev.map((entry) =>
            entry.jobId === job_id
              ? { ...entry, status: job.status }
              : entry
          )
        );
      });

      if (finalJob.status === "failed") {
        setLastError(finalJob.error || "Unknown error");
        setJobStatus("failed");
      } else {
        setJobStatus("completed");

        // Parse model info from job result
        if (finalJob.result) {
          try {
            const resultData = JSON.parse(finalJob.result);
            setModelInfo({
              provider: resultData.model_info?.provider,
              ai_model_used: resultData.ai_model_used,
              generation_time: resultData.model_info?.generation_time,
            });
          } catch {
            // Result may not be JSON
          }
        }

        // Fetch USD layer data after successful completion
        if (sceneIdRef.current) {
          await fetchLayerData(sceneIdRef.current);
        }

        setTimeout(() => setJobStatus("idle"), 3000);
      }

      if (finalJob.status === "completed") {
        setPrompt("");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setLastError(message);
      setJobStatus("failed");
    }
  }, [prompt, isProcessing, fetchLayerData]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <aside
      className="flex flex-col h-full"
      style={{
        width: "var(--sidebar-width)",
        background: "var(--bg-secondary)",
        borderLeft: "1px solid var(--border-subtle)",
      }}
    >
      {/* Panel Header */}
      <div
        className="flex items-center justify-between px-4 shrink-0"
        style={{
          height: "var(--header-height)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <h2
          className="text-sm font-semibold tracking-wide uppercase"
          style={{ color: "var(--text-secondary)" }}
        >
          Prompt
        </h2>
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full transition-all duration-300"
            style={{
              background: statusConfig.color,
              boxShadow: statusConfig.glow,
            }}
          />
          <span
            className="text-xs font-mono"
            style={{ color: "var(--text-muted)" }}
          >
            {statusConfig.label}
          </span>
        </div>
      </div>

      {/* Prompt Input Area */}
      <div className="flex-1 flex flex-col p-4 gap-3 overflow-hidden">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            id="prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Describe your 3D scene...\n\ne.g., "A red cube on a wooden table with a spotlight"`}
            disabled={isProcessing}
            className="w-full h-full resize-none rounded-lg p-3 text-sm font-mono outline-none transition-all focus:ring-1"
            style={{
              background: "var(--bg-tertiary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              transition: `border-color var(--duration-fast) var(--ease-out),
                           box-shadow var(--duration-fast) var(--ease-out)`,
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--border-active)";
              e.currentTarget.style.boxShadow = "0 0 12px var(--accent-glow)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--border-subtle)";
              e.currentTarget.style.boxShadow = "none";
            }}
          />
        </div>

        {/* Error Display */}
        {lastError && (
          <div
            className="px-3 py-2 rounded-lg text-xs font-mono animate-fade-in"
            style={{
              background: "rgba(255, 82, 82, 0.1)",
              border: "1px solid rgba(255, 82, 82, 0.3)",
              color: "var(--error)",
            }}
          >
            <span className="font-semibold">Error: </span>
            {lastError}
          </div>
        )}

        {/* Submit Button */}
        <button
          id="submit-prompt"
          onClick={handleSubmit}
          disabled={!prompt.trim() || isProcessing}
          className="relative w-full py-2.5 px-4 rounded-lg text-sm font-semibold
                     transition-all duration-200 cursor-pointer
                     disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background:
              prompt.trim() && !isProcessing
                ? "var(--accent-gradient)"
                : "var(--bg-tertiary)",
            color:
              prompt.trim() && !isProcessing ? "white" : "var(--text-muted)",
            border: "none",
          }}
        >
          {isProcessing ? (
            <span className="flex items-center justify-center gap-2">
              <span
                className="inline-block w-4 h-4 rounded-full border-2 border-t-transparent animate-spin"
                style={{
                  borderColor: "var(--accent-primary)",
                  borderTopColor: "transparent",
                }}
              />
              {jobStatus === "queued" ? "Queued..." : "Generating..."}
            </span>
          ) : (
            <span>
              Generate Scene{" "}
              <kbd
                className="ml-2 px-1.5 py-0.5 rounded text-xs font-mono"
                style={{
                  background: "rgba(255,255,255,0.15)",
                  color: "rgba(255,255,255,0.7)",
                }}
              >
                ⌘↵
              </kbd>
            </span>
          )}
        </button>

        <p
          className="text-xs text-center"
          style={{ color: "var(--text-muted)" }}
        >
          AI will generate assets and assemble a 3D scene via OpenUSD.
        </p>
      </div>

      {/* USD Layers Panel */}
      <div
        className="shrink-0 px-4 py-3"
        style={{ borderTop: "1px solid var(--border-subtle)" }}
      >
        <div className="flex items-center justify-between">
          <span
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: "var(--text-muted)" }}
          >
            USD Layers
          </span>
          <div className="flex items-center gap-2">
            <span
              className="text-xs font-mono px-1.5 py-0.5 rounded"
              style={{
                background: "var(--bg-tertiary)",
                color: "var(--text-muted)",
              }}
            >
              {layerInfo
                ? `${layerInfo.has_base_layer ? 1 : 0} + ${layerInfo.override_count}`
                : "0"}
            </span>
            {composedUsda && (
              <button
                onClick={() => setShowUsda(!showUsda)}
                className="text-xs font-mono px-1.5 py-0.5 rounded cursor-pointer transition-colors"
                style={{
                  background: showUsda
                    ? "var(--accent-primary)"
                    : "var(--bg-tertiary)",
                  color: showUsda ? "white" : "var(--text-muted)",
                }}
              >
                {showUsda ? "Hide" : "View"}
              </button>
            )}
          </div>
        </div>

        {/* Layer Stack Summary */}
        {layerInfo && layerInfo.has_base_layer ? (
          <div className="mt-2 flex flex-col gap-1">
            <div
              className="flex items-center gap-2 text-xs px-2 py-1 rounded"
              style={{ background: "var(--bg-tertiary)" }}
            >
              <div
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: "var(--accent-primary)" }}
              />
              <span
                className="flex-1 font-mono"
                style={{ color: "var(--text-secondary)" }}
              >
                Base Layer
              </span>
              <span
                className="font-mono"
                style={{ color: "var(--text-muted)" }}
              >
                {(layerInfo.base_layer_size / 1024).toFixed(1)}KB
              </span>
            </div>
            {/* Model Provider Badge */}
            {modelInfo && (
              <div
                className="flex items-center gap-2 text-xs px-2 py-1 rounded"
                style={{ background: "var(--bg-tertiary)" }}
              >
                <div
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{
                    background: modelInfo.ai_model_used
                      ? "var(--success)"
                      : "var(--text-muted)",
                  }}
                />
                <span
                  className="flex-1 font-mono"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {modelInfo.ai_model_used ? "AI" : "Procedural"}
                  {modelInfo.provider && ` (${modelInfo.provider})`}
                </span>
                {modelInfo.generation_time != null && (
                  <span
                    className="font-mono"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {modelInfo.generation_time}s
                  </span>
                )}
              </div>
            )}
            {layerInfo.override_count > 0 && (
              <div
                className="flex items-center gap-2 text-xs px-2 py-1 rounded"
                style={{ background: "var(--bg-tertiary)" }}
              >
                <div
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: "var(--warning)" }}
                />
                <span
                  className="flex-1 font-mono"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {layerInfo.override_count} Override
                  {layerInfo.override_count !== 1 ? "s" : ""}
                </span>
              </div>
            )}
          </div>
        ) : (
          <p
            className="text-xs mt-1"
            style={{ color: "var(--text-muted)", opacity: 0.6 }}
          >
            No layers yet. Generate a scene to begin.
          </p>
        )}

        {/* Collapsible USDA Preview */}
        {showUsda && composedUsda && (
          <div className="mt-2">
            <pre
              className="text-xs font-mono p-2 rounded-lg overflow-auto"
              style={{
                background: "var(--bg-primary)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border-subtle)",
                maxHeight: "200px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {composedUsda}
            </pre>
          </div>
        )}
      </div>

      {/* Job History Panel */}
      <div
        className="shrink-0 px-4 py-3 max-h-36 overflow-y-auto"
        style={{ borderTop: "1px solid var(--border-subtle)" }}
      >
        <div className="flex items-center justify-between mb-2">
          <span
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: "var(--text-muted)" }}
          >
            History
          </span>
          <span
            className="text-xs font-mono px-1.5 py-0.5 rounded"
            style={{
              background: "var(--bg-tertiary)",
              color: "var(--text-muted)",
            }}
          >
            {jobHistory.length}
          </span>
        </div>

        {jobHistory.length === 0 ? (
          <p
            className="text-xs"
            style={{ color: "var(--text-muted)", opacity: 0.6 }}
          >
            No jobs yet. Submit a prompt to begin.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {jobHistory.slice(0, 10).map((entry) => (
              <div
                key={entry.jobId}
                className="flex items-center gap-2 text-xs px-2 py-1.5 rounded"
                style={{ background: "var(--bg-tertiary)" }}
              >
                <div
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{
                    background:
                      (STATUS_CONFIG[entry.status] || STATUS_CONFIG.idle).color,
                  }}
                />
                <span
                  className="truncate flex-1 font-mono"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {entry.prompt}
                </span>
                <span
                  className="shrink-0 font-mono"
                  style={{ color: "var(--text-muted)" }}
                >
                  {entry.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
