/**
 * ask-agi — Human-as-API for frontier models.
 *
 * Final UX model:
 * - foreground: current Pi model compiles the prompt
 * - background: prompt is sent to Telegram
 * - later: frontier reply is injected back into Pi as a follow-up
 */

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

import { loadConfig, getDefaultModel, getModel, getModelIds, type ModelConfig } from "../../src/core/config.js";
import { generateRequestId } from "../../src/core/requests.js";
import {
  getTelegramConfig,
  sendMessage as sendTelegram,
  waitForReply as waitTelegram,
} from "../../src/channels/telegram.js";

type AskAgiParams = {
  question?: string;
  context?: string;
  prompt?: string;
  target_model?: string;
  output_format?: "prose" | "code" | "structured" | "diff";
  reasoning_depth?: "standard" | "deep" | "exhaustive";
  channel?: "telegram" | "auto";
};

type RequestStatus = "compiling" | "sending" | "waiting_response" | "completed" | "cancelled" | "error";

interface PendingRequest {
  id: string;
  model: ModelConfig;
  question?: string;
  context?: string;
  prompt: string;
  outputFormat?: AskAgiParams["output_format"];
  reasoningDepth?: AskAgiParams["reasoning_depth"];
  status: RequestStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

const requests = new Map<string, PendingRequest>();

const PROMPT_COMPILER_SYSTEM_PROMPT = `You are ask-agi's prompt compiler.

Your job is to turn a raw escalation request into one excellent, paste-ready prompt for a frontier model that the human will use in a web UI.

Rules:
- Follow the official prompting guide provided in the user message. Treat it as the source of truth.
- The frontier model has ZERO access to the current Pi session, files, tools, or hidden context. Include everything it needs.
- Preserve the real task. Do not water it down.
- Honor the requested output format and reasoning depth.
- Use explicit output contracts, completion criteria, and verification clauses when they improve results.
- Output ONLY the final prompt text.
- Do NOT wrap the prompt in markdown fences.
- Do NOT add commentary like "Here is the prompt".`;

function textFromResponse(response: Awaited<ReturnType<typeof complete>>): string {
  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim();
}

async function fetchGuide(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Failed to fetch prompting guide: ${response.status} ${response.statusText}`);
  return await response.text();
}

function buildCompilerInput(model: ModelConfig, params: AskAgiParams, guide: string): string {
  return [
    `# Frontier model`,
    `${model.name} (${model.id})`,
    "",
    `# User's core question`,
    params.question?.trim() || "(none provided)",
    "",
    `# Additional context`,
    params.context?.trim() || "(none provided)",
    "",
    `# Desired output format`,
    params.output_format ?? "prose",
    "",
    `# Desired reasoning depth`,
    params.reasoning_depth ?? "deep",
    "",
    `# Official prompting guide`,
    guide,
    "",
    `# Requirements for the compiled prompt`,
    `- It must be ready for the human to paste directly into ${model.name}.`,
    `- It must include all context the frontier model needs.`,
    `- It must ask for a concrete answer that helps the current task move forward.`,
    `- It should be concise when possible, but complete when necessary.`,
    `- If the task benefits from explicit structure, add an output contract and completion criteria.`,
  ].join("\n");
}

async function generatePromptWithCurrentModel(
  ctx: ExtensionContext,
  model: ModelConfig,
  params: AskAgiParams,
  signal?: AbortSignal,
): Promise<string> {
  if (!ctx.model) throw new Error("No active Pi model available to compile the frontier prompt.");

  const guide = await fetchGuide(model.guideUrl, signal);
  const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: buildCompilerInput(model, params, guide) }],
    timestamp: Date.now(),
  };

  const response = await complete(
    ctx.model,
    { systemPrompt: PROMPT_COMPILER_SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey, signal },
  );

  if (response.stopReason === "aborted") throw new Error("Prompt generation aborted.");
  const prompt = stripMarkdownFences(textFromResponse(response));
  if (!prompt) throw new Error("Prompt generation returned empty output.");
  return prompt;
}

function markRequest(request: PendingRequest, patch: Partial<PendingRequest>): PendingRequest {
  const next = { ...request, ...patch, updatedAt: Date.now() };
  requests.set(request.id, next);
  return next;
}

function activeRequests(): PendingRequest[] {
  return [...requests.values()]
    .filter((r) => !["completed", "cancelled"].includes(r.status))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function requestSummary(request: PendingRequest): string {
  return `🧠 ${request.id} · ${request.model.name} · ${request.status}`;
}

function refreshWidget(ctx: ExtensionContext | ExtensionCommandContext): void {
  const pending = activeRequests();
  if (pending.length === 0) {
    ctx.ui.setWidget("ask-agi", undefined);
    return;
  }
  ctx.ui.setWidget("ask-agi", pending.slice(0, 6).map(requestSummary));
}

function queueFrontierResponse(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  request: PendingRequest,
  response: string,
): void {
  const content = [
    `Frontier response received for ask_agi request ${request.id}.`,
    `Model: ${request.model.name}`,
    request.question ? `Original question: ${request.question}` : undefined,
    request.context ? `Context:\n${request.context}` : undefined,
    `Frontier response:\n${response}`,
    `Use this to continue the task.`,
  ].filter(Boolean).join("\n\n");

  if (ctx.isIdle()) {
    pi.sendUserMessage(content);
  } else {
    pi.sendUserMessage(content, { deliverAs: "followUp" });
    ctx.ui.notify(`Queued frontier response for ${request.id} as follow-up.`, "info");
  }
}

async function startTelegramFlow(pi: ExtensionAPI, ctx: ExtensionContext, request: PendingRequest): Promise<void> {
  try {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig) throw new Error("Telegram is not configured.");

    const sending = markRequest(request, { status: "sending" });
    refreshWidget(ctx);

    const header = [
      `🧠 ask-agi → ${sending.model.name}`,
      `Request: ${sending.id}`,
      `Paste the prompt into ${sending.model.name}.`,
      `Then reply directly to the prompt message/file in this chat with the model's response.`,
    ].join("\n");

    const messageId = await sendTelegram(telegramConfig, sending.prompt, header);
    if (!messageId) throw new Error("Failed to send Telegram message.");

    const waiting = markRequest(sending, { status: "waiting_response" });
    refreshWidget(ctx);
    ctx.ui.notify(`ask-agi ${waiting.id} sent to Telegram.`, "info");

    const reply = await waitTelegram(telegramConfig, messageId);
    if (!reply) {
      markRequest(waiting, { status: "cancelled", error: "No Telegram reply received." });
      refreshWidget(ctx);
      ctx.ui.notify(`ask-agi ${waiting.id} cancelled: no Telegram reply.`, "warning");
      return;
    }

    const done = markRequest(waiting, { status: "completed" });
    pi.appendEntry("ask-agi-result", {
      requestId: done.id,
      targetModel: done.model.id,
      question: done.question,
      context: done.context,
      prompt: done.prompt,
      response: reply,
      timestamp: Date.now(),
    });
    refreshWidget(ctx);
    queueFrontierResponse(pi, ctx, done, reply);
    ctx.ui.notify(`ask-agi ${done.id} reply received from Telegram.`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markRequest(request, { status: "error", error: message });
    refreshWidget(ctx);
    ctx.ui.notify(`ask-agi ${request.id} failed: ${message}`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const defaultModel = getDefaultModel(config);
  const modelIds = getModelIds(config);

  pi.registerCommand("ask-agi-status", {
    description: "Show active ask-agi requests",
    handler: async (_args, ctx) => {
      const pending = activeRequests();
      if (pending.length === 0) {
        ctx.ui.notify("No active ask-agi requests.", "info");
      } else {
        ctx.ui.notify(pending.map(requestSummary).join("\n"), "info");
      }
      refreshWidget(ctx);
    },
  });

  pi.registerTool({
    name: "ask_agi",
    label: "Ask AGI",
    description:
      "Escalate a hard problem to a frontier model through Telegram. ask_agi compiles the final prompt in the foreground, sends it to Telegram in the background, and injects the reply back into Pi later.",
    promptSnippet:
      "Escalate hard problems with ask_agi. Provide question + context; ask_agi compiles now, Telegram handles the background handoff.",
    promptGuidelines: [
      `Available frontier models: ${modelIds.join(", ")}. Default: ${defaultModel.id}.`,
      "Prefer passing question + context. ask_agi will fetch the official prompting guide and compile the final prompt itself.",
      "ask_agi is background-oriented: it compiles in the foreground, sends via Telegram, then injects the reply back later.",
      "Include all relevant files, errors, constraints, and desired outcome in context — the frontier model sees nothing else.",
      "Use prompt only as an advanced override when you already have the exact frontier prompt.",
    ],
    parameters: Type.Object({
      question: Type.Optional(Type.String({
        description: "The core question or task for the frontier model",
      })),
      context: Type.Optional(Type.String({
        description: "All relevant context, code, constraints, errors, and goals the frontier model will need",
      })),
      prompt: Type.Optional(Type.String({
        description: "Advanced override: a fully crafted prompt. If omitted, ask_agi will generate it for you.",
      })),
      target_model: Type.Optional(Type.String({
        description: `Target model ID. Available: ${modelIds.join(", ")}. Default: ${defaultModel.id}`,
      })),
      output_format: Type.Optional(Type.String({
        description: "Desired output shape: prose, code, structured, or diff",
      })),
      reasoning_depth: Type.Optional(Type.String({
        description: "Desired reasoning depth: standard, deep, or exhaustive",
      })),
      channel: Type.Optional(Type.String({
        description: "Delivery channel. Supported: telegram, auto",
      })),
    }),

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as AskAgiParams;

      if (!getTelegramConfig()) {
        return {
          content: [{ type: "text", text: "ask_agi requires ASK_AGI_TELEGRAM_BOT_TOKEN and ASK_AGI_TELEGRAM_CHAT_ID." }],
          details: { status: "error" },
        };
      }

      if (!params.prompt?.trim() && !params.question?.trim()) {
        return {
          content: [{ type: "text", text: "ask_agi requires either question or prompt." }],
          details: { status: "error" },
        };
      }

      if (params.channel && !["telegram", "auto"].includes(params.channel)) {
        return {
          content: [{ type: "text", text: "ask_agi currently supports only telegram/auto background delivery." }],
          details: { status: "error" },
        };
      }

      const model = params.target_model ? getModel(config, params.target_model) : defaultModel;
      if (!model) {
        return {
          content: [{ type: "text", text: `Unknown model: ${params.target_model}. Available: ${modelIds.join(", ")}` }],
          details: { status: "error" },
        };
      }

      const requestId = generateRequestId();
      const initial: PendingRequest = {
        id: requestId,
        model,
        question: params.question?.trim(),
        context: params.context?.trim(),
        prompt: "",
        outputFormat: params.output_format,
        reasoningDepth: params.reasoning_depth,
        status: "compiling",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      requests.set(requestId, initial);
      refreshWidget(ctx);

      try {
        const prompt = params.prompt?.trim()
          ? params.prompt.trim()
          : await generatePromptWithCurrentModel(ctx, model, params, signal);

        const ready = markRequest(initial, { prompt, status: "sending" });
        refreshWidget(ctx);

        void startTelegramFlow(pi, ctx, ready);

        return {
          content: [{
            type: "text",
            text: `Started ask_agi request ${requestId} for ${model.name}. The prompt is ready and is being sent to Telegram in the background. You can keep chatting; I'll inject the frontier reply back when it arrives.`,
          }],
          details: { requestId, targetModel: model.id, status: "sending", channel: "telegram" },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markRequest(initial, { status: "error", error: message });
        refreshWidget(ctx);
        return {
          content: [{ type: "text", text: `ask_agi failed while preparing the prompt: ${message}` }],
          details: { requestId, targetModel: model.id, status: "error", channel: "telegram" },
        };
      }
    },

    renderCall(args, theme) {
      const target = String(args.target_model || defaultModel.id);
      let text = theme.fg("toolTitle", theme.bold("ask_agi ")) + theme.fg("accent", `→ ${target}`);
      const preview = String(args.question || args.prompt || "").slice(0, 100).replace(/\n/g, " ");
      if (preview) text += `\n  ${theme.fg("muted", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as { requestId?: string; targetModel?: string; status?: string; channel?: string } | undefined;
      if (!details?.requestId) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text.slice(0, 100) : "", 0, 0);
      }

      const icon = details.status === "error"
        ? theme.fg("warning", "!")
        : theme.fg("success", "↗");

      return new Text(
        `${icon} ${theme.fg("accent", details.targetModel || "unknown")} ${theme.fg("dim", details.requestId)} ${theme.fg("muted", `(${details.channel || "telegram"})`)}`,
        0,
        0,
      );
    },
  });
}
