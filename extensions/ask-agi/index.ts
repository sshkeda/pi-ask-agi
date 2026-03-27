/**
 * ask-agi — Human-as-API for frontier models.
 *
 * Final UX model:
 * - foreground: current Pi model compiles the prompt
 * - background: prompt is sent to Telegram
 * - later: frontier reply is injected back into Pi as a follow-up
 */

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
  prompt: string;
  question?: string;
  target_model?: string;
  channel?: "telegram" | "auto";
};

type RequestStatus = "sending" | "waiting_response" | "completed" | "cancelled" | "error";

interface PendingRequest {
  id: string;
  model: ModelConfig;
  question?: string;
  prompt: string;
  status: RequestStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

const requests = new Map<string, PendingRequest>();

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
  request: PendingRequest,
  response: string,
): void {
  const content = [
    `Frontier response received for ask_agi request ${request.id}.`,
    `Model: ${request.model.name}`,
    request.question ? `Original question: ${request.question}` : undefined,
    `Frontier response:\n${response}`,
    `Use this to continue the task.`,
  ].filter(Boolean).join("\n\n");

  // No deliverAs — sendUserMessage "always triggers a turn".
  // followUp requires an active turn to follow, which may not exist if Pi is idle.
  pi.sendUserMessage(content);
}

async function startTelegramFlow(pi: ExtensionAPI, request: PendingRequest): Promise<void> {
  try {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig) throw new Error("Telegram is not configured.");

    const sending = markRequest(request, { status: "sending" });

    const caption = `🧠 ask-agi → ${sending.model.name} (${sending.id})\nPaste into ${sending.model.name}, then reply to this message with the response.`;

    const messageId = await sendTelegram(telegramConfig, sending.prompt, caption);
    if (!messageId) throw new Error("Failed to send Telegram message.");

    markRequest(sending, { status: "waiting_response" });

    const reply = await waitTelegram(telegramConfig, messageId);
    if (!reply) {
      markRequest(request, { status: "cancelled", error: "No Telegram reply received." });
      return;
    }

    const done = markRequest(request, { status: "completed" });
    pi.appendEntry("ask-agi-result", {
      requestId: done.id,
      targetModel: done.model.id,
      question: done.question,
      prompt: done.prompt,
      response: reply,
      timestamp: Date.now(),
    });
    queueFrontierResponse(pi, done, reply);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markRequest(request, { status: "error", error: message });
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
      "Escalate a hard problem to a frontier model through Telegram. You compile the prompt, ask_agi delivers it via Telegram, and injects the reply back into Pi later.",
    promptSnippet:
      "Escalate hard problems with ask_agi. You compile the full paste-ready prompt yourself, then pass it to ask_agi for Telegram delivery.",
    promptGuidelines: [
      `Target model: ${defaultModel.name}. Prompting guide: ${defaultModel.guideUrl}`,
      "YOU are the prompt compiler. Before calling ask_agi, fetch the prompting guide above with fetch_page, then write a prompt that follows it.",
      "The frontier model has ZERO access to this Pi session, files, tools, or hidden context. Include everything it needs in the prompt.",
      "ask_agi is a pure delivery mechanism — it sends your prompt as a .txt file to Telegram and injects the reply back later.",
      "Include a short `question` for display/tracking purposes (shown in the widget and logs).",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The full, paste-ready prompt for the frontier model. You compile this yourself — include all context, code, constraints, and goals.",
      }),
      question: Type.Optional(Type.String({
        description: "Short summary of the question (for display/tracking in the widget)",
      })),
      target_model: Type.Optional(Type.String({
        description: `Target model ID. Available: ${modelIds.join(", ")}. Default: ${defaultModel.id}`,
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

      if (!params.prompt?.trim()) {
        return {
          content: [{ type: "text", text: "ask_agi requires a compiled prompt. You must write the full prompt yourself and pass it as the `prompt` parameter." }],
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
      const request: PendingRequest = {
        id: requestId,
        model,
        question: params.question?.trim(),
        prompt: params.prompt.trim(),
        status: "sending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      requests.set(requestId, request);

      try {
        void startTelegramFlow(pi, request);

        return {
          content: [{
            type: "text",
            text: `Started ask_agi request ${requestId} for ${model.name}. Sending to Telegram in the background. The frontier reply will be injected back when it arrives.`,
          }],
          details: { requestId, targetModel: model.id, status: "sending", channel: "telegram" },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markRequest(request, { status: "error", error: message });
        refreshWidget(ctx);
        return {
          content: [{ type: "text", text: `ask_agi failed: ${message}` }],
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
