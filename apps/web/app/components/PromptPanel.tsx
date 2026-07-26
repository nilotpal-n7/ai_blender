"use client";

import { useState, useRef, useCallback } from "react";

/**
 * PromptPanel — Script/prompt editor sidebar.
 *
 * Provides the text input interface where users enter prompts
 * for AI scene generation. Will eventually support:
 * - Multi-line script editing
 * - Prompt history
 * - USD override display
 * - Job status monitoring
 */
export default function PromptPanel() {
  const [prompt, setPrompt] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim() || isProcessing) return;

    setIsProcessing(true);

    // TODO: Send prompt + USD override layer to orchestrator API
    // POST /api/v1/scene/:id/prompt
    console.log("[PromptPanel] Submitting prompt:", prompt);

    // Simulate processing delay (remove when API is connected)
    setTimeout(() => {
      setIsProcessing(false);
    }, 2000);
  }, [prompt, isProcessing]);

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
            className="w-2 h-2 rounded-full"
            style={{
              background: isProcessing ? "var(--warning)" : "var(--success)",
              boxShadow: isProcessing
                ? "0 0 8px var(--warning)"
                : "0 0 8px var(--success)",
            }}
          />
          <span
            className="text-xs font-mono"
            style={{ color: "var(--text-muted)" }}
          >
            {isProcessing ? "Processing..." : "Ready"}
          </span>
        </div>
      </div>

      {/* Prompt Input Area */}
      <div className="flex-1 flex flex-col p-4 gap-3 overflow-hidden">
        {/* Textarea */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            id="prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your 3D scene...&#10;&#10;e.g., &quot;A cyberpunk street at night with neon signs, a parked motorcycle, and rain puddles reflecting the lights&quot;"
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
              prompt.trim() && !isProcessing
                ? "white"
                : "var(--text-muted)",
            border: "none",
          }}
        >
          {isProcessing ? (
            <span className="flex items-center justify-center gap-2">
              <span className="animate-shimmer inline-block w-4 h-4 rounded-full" />
              Generating...
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

        {/* Info Footer */}
        <p
          className="text-xs text-center"
          style={{ color: "var(--text-muted)" }}
        >
          AI will generate assets and assemble a 3D scene via OpenUSD.
        </p>
      </div>

      {/* Scene Layers Panel (collapsed placeholder) */}
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
          <span
            className="text-xs font-mono px-1.5 py-0.5 rounded"
            style={{
              background: "var(--bg-tertiary)",
              color: "var(--text-muted)",
            }}
          >
            0
          </span>
        </div>
        <p
          className="text-xs mt-1"
          style={{ color: "var(--text-muted)", opacity: 0.6 }}
        >
          No layers yet. Generate a scene to begin.
        </p>
      </div>
    </aside>
  );
}
