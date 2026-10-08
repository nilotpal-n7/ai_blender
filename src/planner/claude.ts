/**
 * Claude planner — a streaming tool-use loop.
 *
 * Claude edits the scene by calling tools. Each call is validated and applied
 * to a working copy as soon as it has fully arrived, and the resulting ops are
 * streamed to the browser, so objects appear while the model is still writing.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Scene } from "@/scene/types";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";
import { TOOL_SPECS, ToolError, runTool, toolInputSchema } from "./tools";
import { PlannerError, type PlanInput, type Planner } from "./types";

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;
type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

/** The slice of the SDK the planner uses, so tests can script a conversation. */
export interface PlannerStream {
  on(event: "text" | "thinking", listener: (delta: string) => void): unknown;
  on(event: "contentBlock", listener: (block: ContentBlock) => void): unknown;
  finalMessage(): Promise<Message>;
}
export interface MessagesApi {
  stream(body: StreamParams, options?: { signal?: AbortSignal }): PlannerStream;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export interface ClaudePlannerOptions {
  model: string;
  effort: Effort;
}

/** Rounds of tool calls before giving up; a scene normally takes one to three. */
const MAX_ROUNDS = 12;
const MAX_HISTORY_MESSAGES = 12;

const TOOLS: Anthropic.Beta.BetaTool[] = TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  input_schema: toolInputSchema(spec) as Anthropic.Beta.BetaTool.InputSchema,
  // Stream each call's input as it is written instead of buffering it. The API
  // then skips validation, which runTool does before anything is applied.
  eager_input_streaming: true,
}));

function historyMessages(chat: PlanInput["chat"]): MessageParam[] {
  const recent = chat.filter((m) => m.text.trim() !== "").slice(-MAX_HISTORY_MESSAGES);
  // The API requires the conversation to open with a user message.
  const start = recent.findIndex((m) => m.role === "user");
  return start < 0 ? [] : recent.slice(start).map((m) => ({ role: m.role, content: m.text }));
}

/** Turns SDK failures into messages worth showing in the chat panel. */
function explain(err: unknown): unknown {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new PlannerError(
      "The Anthropic API rejected the credentials. Check ANTHROPIC_API_KEY in .env.local.",
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new PlannerError("The Anthropic API is rate limiting requests. Try again in a moment.");
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new PlannerError("Could not reach the Anthropic API. Check your connection.");
  }
  if (err instanceof Anthropic.APIError) {
    return new PlannerError(`Anthropic API error (${err.status ?? "no status"}): ${err.message}`);
  }
  return err;
}

export function createClaudePlanner(api: MessagesApi, options: ClaudePlannerOptions): Planner {
  return {
    name: options.model,

    async run(input, emit, signal) {
      const messages: MessageParam[] = [
        ...historyMessages(input.chat),
        { role: "user", content: buildUserMessage(input) },
      ];
      const usage = { inputTokens: 0, outputTokens: 0 };
      let scene: Scene = input.scene;
      let wroteText = false;

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const stream = api.stream(
          {
            model: options.model,
            max_tokens: 64000,
            // If a safety classifier declines, retry on Anthropic's recommended model.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: options.effort },
            system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            tools: TOOLS,
            messages,
          },
          { signal },
        );

        // A call is only run once something follows it (another block, or a
        // clean end of message), which proves its input was not cut off.
        const results = new Map<string, ToolResult>();
        const pending: { call: ToolUse | null } = { call: null };
        const runPending = () => {
          const call = pending.call;
          if (!call) return;
          pending.call = null;
          try {
            const outcome = runTool(scene, call.name, call.input);
            scene = outcome.scene;
            emit({ type: "ops", ops: outcome.ops });
            results.set(call.id, {
              type: "tool_result",
              tool_use_id: call.id,
              content: outcome.result,
            });
          } catch (err) {
            if (!(err instanceof ToolError)) throw err;
            results.set(call.id, {
              type: "tool_result",
              tool_use_id: call.id,
              is_error: true,
              content: err.message,
            });
          }
        };

        let textThisRound = false;
        stream.on("text", (delta) => {
          if (!textThisRound && wroteText) emit({ type: "text", delta: "\n\n" });
          textThisRound = wroteText = true;
          emit({ type: "text", delta });
        });
        stream.on("thinking", (delta) => emit({ type: "thinking", delta }));
        stream.on("contentBlock", (block) => {
          if (block.type !== "tool_use") return;
          runPending();
          pending.call = block;
        });

        let message: Message;
        try {
          message = await stream.finalMessage();
        } catch (err) {
          if (signal.aborted || err instanceof Anthropic.APIError) throw explain(err);
          // With eager input streaming, a tool input that isn't parseable JSON
          // surfaces here as a plain error rather than an API error.
          throw new PlannerError(
            "The model sent a malformed tool call. Anything already built was kept; try again.",
          );
        }

        usage.inputTokens +=
          message.usage.input_tokens +
          (message.usage.cache_read_input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0);
        usage.outputTokens += message.usage.output_tokens;

        if (message.stop_reason === "refusal") {
          throw new PlannerError("The model declined this request.");
        }
        const cutOff = message.stop_reason === "max_tokens";
        if (!cutOff) runPending();

        const calls = message.content.filter((block) => block.type === "tool_use");
        if (calls.length === 0) {
          if (cutOff) throw new PlannerError("The reply was cut off before it finished.");
          return usage;
        }

        messages.push({ role: "assistant", content: message.content });
        messages.push({
          role: "user",
          content: calls.map(
            (call): ToolResult =>
              results.get(call.id) ?? {
                type: "tool_result",
                tool_use_id: call.id,
                is_error: true,
                content: "This call was cut off before it was complete. Send it again.",
              },
          ),
        });
      }

      throw new PlannerError(
        `Stopped after ${MAX_ROUNDS} rounds of edits. What was built so far has been kept.`,
      );
    },
  };
}

export function claudeMessagesApi(client: Anthropic = new Anthropic()): MessagesApi {
  return { stream: (body, options) => client.beta.messages.stream(body, options) };
}
