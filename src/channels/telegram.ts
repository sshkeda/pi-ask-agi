/**
 * Telegram delivery channel.
 *
 * Sends the compiled prompt via Telegram bot, waits for
 * the user to reply with the frontier model's response.
 *
 * Env vars: ASK_AGI_TELEGRAM_BOT_TOKEN, ASK_AGI_TELEGRAM_CHAT_ID
 */

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

interface TelegramChat {
  id: number | string;
}

interface TelegramDocument {
  file_id: string;
}

interface TelegramReplyToMessage {
  message_id: number;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  reply_to_message?: TelegramReplyToMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

type Listener = (message: TelegramMessage) => void | Promise<void>;

interface TelegramDispatcher {
  config: TelegramConfig;
  offset: number;
  listeners: Set<Listener>;
  polling: boolean;
}

export function getTelegramConfig(): TelegramConfig | null {
  const botToken = process.env.ASK_AGI_TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ASK_AGI_TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

const API = (token: string) => `https://api.telegram.org/bot${token}`;
const FILE_API = (token: string, filePath: string) => `https://api.telegram.org/file/bot${token}/${filePath}`;
// Generation counter — bumped on every module load (including /reload).
// Old polling loops detect the mismatch and exit, preventing
// two loops from competing for getUpdates on the same bot.
const GEN_KEY = "__askAgiPollGeneration";
(globalThis as any)[GEN_KEY] = ((globalThis as any)[GEN_KEY] || 0) + 1;
const currentGeneration: number = (globalThis as any)[GEN_KEY];

const dispatchers = new Map<string, TelegramDispatcher>();

/**
 * Send a prompt delivery.
 * Always a single .txt file attachment with the caption as instructions.
 * One message = one thing to reply to. No confusion.
 */
export async function sendMessage(
  config: TelegramConfig,
  prompt: string,
  caption?: string,
): Promise<number | null> {
  return await sendTextAttachment(config, prompt, caption);
}

async function sendTextAttachment(
  config: TelegramConfig,
  text: string,
  caption?: string,
): Promise<number | null> {
  const form = new FormData();
  form.set("chat_id", config.chatId);
  form.set("caption", caption || "🧠 ask-agi prompt. Reply to this message with the response.");
  form.set(
    "document",
    new Blob([text], { type: "text/plain;charset=utf-8" }),
    `ask-agi-${Date.now()}.txt`,
  );

  const resp = await fetch(`${API(config.botToken)}/sendDocument`, {
    method: "POST",
    body: form,
  });

  if (!resp.ok) return null;
  const data = await readJson(resp);
  return getNestedNumber(data, ["result", "message_id"]);
}

/**
 * Long-poll for the user's reply to a specific Telegram message.
 *
 * No automatic timeout: this workflow is human-mediated and may take hours.
 * The request only stops if the signal is aborted.
 *
 * To avoid cross-talk between multiple ask-agi requests, a single shared
 * getUpdates loop fans out messages to per-request listeners. Replies must be
 * explicit Telegram replies to the original prompt message/file.
 */
export async function waitForReply(
  config: TelegramConfig,
  afterMessageId: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const dispatcher = getDispatcher(config);
  startPolling(dispatcher);

  return await new Promise((resolve) => {
    let settled = false;

    const cleanup = (result: string | null): void => {
      if (settled) return;
      settled = true;
      dispatcher.listeners.delete(listener);
      resolve(result);
    };

    if (signal?.aborted) {
      cleanup(null);
      return;
    }

    const onAbort = (): void => cleanup(null);
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result: string | null): void => {
      signal?.removeEventListener("abort", onAbort);
      cleanup(result);
    };

    const listener: Listener = async (message) => {
      if (settled) return;
      if (String(message.chat.id) !== config.chatId) return;
      if (message.reply_to_message?.message_id !== afterMessageId) return;

      if (message.text?.trim()) {
        finish(message.text.trim());
        return;
      }

      if (message.document?.file_id) {
        const text = await downloadDocumentText(config, message.document.file_id);
        if (text?.trim()) {
          finish(text.trim());
        }
      }
    };

    dispatcher.listeners.add(listener);
  });
}

function getDispatcher(config: TelegramConfig): TelegramDispatcher {
  const key = `${config.botToken}:${config.chatId}`;
  const existing = dispatchers.get(key);
  if (existing) return existing;

  const created: TelegramDispatcher = {
    config,
    offset: 0,
    listeners: new Set(),
    polling: false,
  };
  dispatchers.set(key, created);
  return created;
}

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message + (error.cause instanceof Error ? " " + error.cause.message : "");
  return /ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|fetch failed|network|socket hang up|TimeoutError|AbortError/i.test(msg);
}

const BASE_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

function startPolling(dispatcher: TelegramDispatcher): void {
  if (dispatcher.polling) return;
  dispatcher.polling = true;

  void (async () => {
    let consecutiveErrors = 0;

    while (dispatcher.polling && (globalThis as any)[GEN_KEY] === currentGeneration) {
      try {
        const resp = await fetch(
          `${API(dispatcher.config.botToken)}/getUpdates?offset=${dispatcher.offset}&timeout=30&allowed_updates=["message"]`,
          { signal: AbortSignal.timeout(35_000) },
        );
        if (!resp.ok) {
          if (resp.status === 401 || resp.status === 403) {
            console.error(`ask-agi Telegram polling: HTTP ${resp.status} — bad bot token, stopping`);
            dispatcher.polling = false;
            break;
          }
          consecutiveErrors++;
          const delay = Math.min(BASE_RETRY_MS * 2 ** (consecutiveErrors - 1), MAX_RETRY_MS);
          console.error(`ask-agi Telegram polling HTTP ${resp.status}, retrying in ${Math.round(delay / 1000)}s`);
          await sleep(delay);
          continue;
        }

        const data = await readJson(resp);
        consecutiveErrors = 0;
        const updates = getUpdates(data);
        for (const update of updates) {
          dispatcher.offset = Math.max(dispatcher.offset, update.update_id + 1);
          if (!update.message) continue;

          const listeners = [...dispatcher.listeners];
          for (const listener of listeners) {
            try {
              await listener(update.message);
            } catch (error) {
              console.error("ask-agi Telegram listener failed:", error);
            }
          }
        }
      } catch (error) {
        consecutiveErrors++;
        const delay = Math.min(BASE_RETRY_MS * 2 ** (consecutiveErrors - 1), MAX_RETRY_MS);

        if (isTransientNetworkError(error)) {
          const cause = error instanceof Error && error.cause instanceof Error ? (error.cause as any).code || error.cause.message : "";
          console.error(`ask-agi Telegram polling: network error${cause ? ` (${cause})` : ""}, retrying in ${Math.round(delay / 1000)}s (attempt ${consecutiveErrors})`);
        } else {
          console.error("ask-agi Telegram polling failed:", error);
        }

        await sleep(delay);
      }
    }
  })();
}

async function downloadDocumentText(
  config: TelegramConfig,
  fileId: string,
): Promise<string | null> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fileInfoResp = await fetch(
        `${API(config.botToken)}/getFile?file_id=${encodeURIComponent(fileId)}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (!fileInfoResp.ok) return null;

      const fileInfo = await readJson(fileInfoResp);
      const filePath = getNestedString(fileInfo, ["result", "file_path"]);
      if (!filePath) return null;

      const fileResp = await fetch(FILE_API(config.botToken, filePath), {
        signal: AbortSignal.timeout(15_000),
      });
      if (!fileResp.ok) return null;
      return await fileResp.text();
    } catch (err) {
      lastErr = err;
      console.error(`ask-agi document download attempt ${attempt + 1}/3 failed:`, err);
      await sleep(1000 * (attempt + 1));
    }
  }
  console.error("ask-agi document download failed after 3 retries — reply may be lost");
  return null;
}

function getUpdates(value: unknown): TelegramUpdate[] {
  if (!isRecord(value)) return [];
  const result = value.result;
  if (!Array.isArray(result)) return [];

  const updates: TelegramUpdate[] = [];
  for (const item of result) {
    if (!isRecord(item)) continue;
    const updateId = item.update_id;
    const message = item.message;
    if (typeof updateId !== "number") continue;
    updates.push({
      update_id: updateId,
      message: isTelegramMessage(message) ? message : undefined,
    });
  }
  return updates;
}

function isTelegramMessage(value: unknown): value is TelegramMessage {
  if (!isRecord(value)) return false;
  return typeof value.message_id === "number" && isRecord(value.chat) && (typeof value.chat.id === "number" || typeof value.chat.id === "string");
}

function getNestedNumber(value: unknown, path: string[]): number | null {
  const result = getNested(value, path);
  return typeof result === "number" ? result : null;
}

function getNestedString(value: unknown, path: string[]): string | null {
  const result = getNested(value, path);
  return typeof result === "string" ? result : null;
}

function getNested(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current) || !(key in current)) return null;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJson(response: Response): Promise<unknown> {
  return await response.json();
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
