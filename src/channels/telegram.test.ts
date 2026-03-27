import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import {
  sendMessage,
  waitForReply,
  getTelegramConfig,
  __resetDispatchers,
  type TelegramConfig,
} from "./telegram.js";

// ── Mock Telegram server ─────────────────────────────────────────────

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void | Promise<void>;

let handler: Handler = (_req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true, result: [] }));
};

function setHandler(h: Handler) {
  handler = h;
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  process.env.__ASK_AGI_TELEGRAM_BASE_URL = baseUrl;
});

afterAll(async () => {
  delete process.env.__ASK_AGI_TELEGRAM_BASE_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  __resetDispatchers();
  handler = (_req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, result: [] }));
  };
});

const config: TelegramConfig = { botToken: "test-token", chatId: "123" };

// ── Helpers ──────────────────────────────────────────────────────────

function parseUrl(req: http.IncomingMessage): URL {
  return new URL(req.url!, `http://${req.headers.host}`);
}

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── Tests ────────────────────────────────────────────────────────────

describe("sendMessage", () => {
  it("sends a document and returns message_id", async () => {
    setHandler((_req, res) => {
      jsonResponse(res, { ok: true, result: { message_id: 42 } });
    });

    const id = await sendMessage(config, "Hello prompt", "Test caption");
    expect(id).toBe(42);
  });

  it("returns null on HTTP error", async () => {
    setHandler((_req, res) => {
      jsonResponse(res, { ok: false }, 500);
    });

    const id = await sendMessage(config, "Hello prompt");
    expect(id).toBeNull();
  });
});

describe("waitForReply — happy path", () => {
  it("receives a text reply to the correct message", async () => {
    const sentMessageId = 100;
    let pollCount = 0;

    setHandler((req, res) => {
      const url = parseUrl(req);
      if (url.pathname.includes("/getUpdates")) {
        pollCount++;
        if (pollCount === 1) {
          // First poll: return a reply
          jsonResponse(res, {
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 200,
                  chat: { id: 123 },
                  text: "Here is the GPT response",
                  reply_to_message: { message_id: sentMessageId },
                },
              },
            ],
          });
        } else {
          jsonResponse(res, { ok: true, result: [] });
        }
        return;
      }
      jsonResponse(res, { ok: true, result: [] });
    });

    const reply = await waitForReply(config, sentMessageId);
    expect(reply).toBe("Here is the GPT response");
  });

  it("ignores messages that are not replies to our message", async () => {
    const sentMessageId = 100;
    let pollCount = 0;

    setHandler((req, res) => {
      const url = parseUrl(req);
      if (url.pathname.includes("/getUpdates")) {
        pollCount++;
        if (pollCount === 1) {
          // Wrong reply_to_message
          jsonResponse(res, {
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 200,
                  chat: { id: 123 },
                  text: "Wrong message",
                  reply_to_message: { message_id: 999 },
                },
              },
            ],
          });
        } else if (pollCount === 2) {
          // Correct reply
          jsonResponse(res, {
            ok: true,
            result: [
              {
                update_id: 2,
                message: {
                  message_id: 201,
                  chat: { id: 123 },
                  text: "Right message",
                  reply_to_message: { message_id: sentMessageId },
                },
              },
            ],
          });
        } else {
          jsonResponse(res, { ok: true, result: [] });
        }
        return;
      }
      jsonResponse(res, { ok: true, result: [] });
    });

    const reply = await waitForReply(config, sentMessageId);
    expect(reply).toBe("Right message");
  });
});

describe("waitForReply — document replies", () => {
  it("downloads document text from a file reply", async () => {
    const sentMessageId = 100;
    let pollCount = 0;

    setHandler((req, res) => {
      const url = parseUrl(req);

      if (url.pathname.includes("/getUpdates")) {
        pollCount++;
        if (pollCount === 1) {
          jsonResponse(res, {
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 200,
                  chat: { id: 123 },
                  document: { file_id: "file-abc" },
                  reply_to_message: { message_id: sentMessageId },
                },
              },
            ],
          });
        } else {
          jsonResponse(res, { ok: true, result: [] });
        }
        return;
      }

      if (url.pathname.includes("/getFile")) {
        jsonResponse(res, {
          ok: true,
          result: { file_path: "documents/response.txt" },
        });
        return;
      }

      if (url.pathname.includes("/file/")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Document content from GPT");
        return;
      }

      jsonResponse(res, { ok: true, result: [] });
    });

    const reply = await waitForReply(config, sentMessageId);
    expect(reply).toBe("Document content from GPT");
  });

  it("retries document download on transient failure", async () => {
    const sentMessageId = 100;
    let pollCount = 0;
    let getFileAttempts = 0;

    setHandler((req, res) => {
      const url = parseUrl(req);

      if (url.pathname.includes("/getUpdates")) {
        pollCount++;
        if (pollCount === 1) {
          jsonResponse(res, {
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 200,
                  chat: { id: 123 },
                  document: { file_id: "file-retry" },
                  reply_to_message: { message_id: sentMessageId },
                },
              },
            ],
          });
        } else {
          jsonResponse(res, { ok: true, result: [] });
        }
        return;
      }

      if (url.pathname.includes("/getFile")) {
        getFileAttempts++;
        if (getFileAttempts < 3) {
          // Simulate transient failure
          res.destroy();
          return;
        }
        jsonResponse(res, {
          ok: true,
          result: { file_path: "documents/response.txt" },
        });
        return;
      }

      if (url.pathname.includes("/file/")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Recovered document");
        return;
      }

      jsonResponse(res, { ok: true, result: [] });
    });

    const reply = await waitForReply(config, sentMessageId);
    expect(reply).toBe("Recovered document");
    expect(getFileAttempts).toBe(3);
  }, 15_000);
});

describe("polling — error handling", () => {
  it("stops polling and resolves null on 401", async () => {
    setHandler((_req, res) => {
      jsonResponse(res, { ok: false, description: "Unauthorized" }, 401);
    });

    const reply = await waitForReply(config, 100);
    expect(reply).toBeNull();
  });

  it("stops polling and resolves null on 403", async () => {
    setHandler((_req, res) => {
      jsonResponse(res, { ok: false, description: "Forbidden" }, 403);
    });

    const reply = await waitForReply(config, 100);
    expect(reply).toBeNull();
  });

  it("stops polling and resolves null on 409 (webhook conflict)", async () => {
    setHandler((_req, res) => {
      jsonResponse(
        res,
        { ok: false, description: "Conflict: terminated by other getUpdates" },
        409,
      );
    });

    const reply = await waitForReply(config, 100);
    expect(reply).toBeNull();
  });

  it("respects 429 retry_after", async () => {
    let requestCount = 0;
    const timestamps: number[] = [];

    setHandler((req, res) => {
      const url = parseUrl(req);
      if (!url.pathname.includes("/getUpdates")) return;

      requestCount++;
      timestamps.push(Date.now());

      if (requestCount === 1) {
        jsonResponse(
          res,
          { ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } },
          429,
        );
        return;
      }

      // Second request: return a reply so the test completes
      jsonResponse(res, {
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 200,
              chat: { id: 123 },
              text: "After rate limit",
              reply_to_message: { message_id: 100 },
            },
          },
        ],
      });
    });

    const reply = await waitForReply(config, 100);
    expect(reply).toBe("After rate limit");
    expect(requestCount).toBe(2);
    // Should have waited ~1s between requests
    const gap = timestamps[1]! - timestamps[0]!;
    expect(gap).toBeGreaterThanOrEqual(900);
  }, 10_000);

  it("uses exponential backoff on server errors", async () => {
    let requestCount = 0;
    const timestamps: number[] = [];

    setHandler((req, res) => {
      const url = parseUrl(req);
      if (!url.pathname.includes("/getUpdates")) return;

      requestCount++;
      timestamps.push(Date.now());

      if (requestCount <= 2) {
        jsonResponse(res, { ok: false }, 500);
        return;
      }

      jsonResponse(res, {
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 200,
              chat: { id: 123 },
              text: "After errors",
              reply_to_message: { message_id: 100 },
            },
          },
        ],
      });
    });

    const reply = await waitForReply(config, 100);
    expect(reply).toBe("After errors");
    expect(requestCount).toBe(3);
    // First retry: ~2s, second retry: ~4s
    const gap1 = timestamps[1]! - timestamps[0]!;
    const gap2 = timestamps[2]! - timestamps[1]!;
    expect(gap1).toBeGreaterThanOrEqual(1800);
    expect(gap2).toBeGreaterThanOrEqual(3600);
  }, 15_000);
});

describe("edge cases — concurrent waiters", () => {
  it("two waiters on different messages each get their own reply", async () => {
    let pollCount = 0;

    setHandler((req, res) => {
      const url = parseUrl(req);
      if (!url.pathname.includes("/getUpdates")) return;

      pollCount++;
      if (pollCount === 1) {
        // Reply to message 100
        jsonResponse(res, {
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 300,
                chat: { id: 123 },
                text: "Reply A",
                reply_to_message: { message_id: 100 },
              },
            },
          ],
        });
      } else if (pollCount === 2) {
        // Reply to message 200
        jsonResponse(res, {
          ok: true,
          result: [
            {
              update_id: 2,
              message: {
                message_id: 301,
                chat: { id: 123 },
                text: "Reply B",
                reply_to_message: { message_id: 200 },
              },
            },
          ],
        });
      } else {
        jsonResponse(res, { ok: true, result: [] });
      }
    });

    const [replyA, replyB] = await Promise.all([
      waitForReply(config, 100),
      waitForReply(config, 200),
    ]);
    expect(replyA).toBe("Reply A");
    expect(replyB).toBe("Reply B");
  });

  it("one waiter resolves, the other keeps waiting", async () => {
    let pollCount = 0;
    const ac = new AbortController();

    setHandler((req, res) => {
      const url = parseUrl(req);
      if (!url.pathname.includes("/getUpdates")) return;

      pollCount++;
      if (pollCount === 1) {
        // Only reply to message 100
        jsonResponse(res, {
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 300,
                chat: { id: 123 },
                text: "Only A",
                reply_to_message: { message_id: 100 },
              },
            },
          ],
        });
      } else {
        jsonResponse(res, { ok: true, result: [] });
      }
    });

    // Waiter B will never get a reply — abort it after 500ms
    setTimeout(() => ac.abort(), 500);

    const [replyA, replyB] = await Promise.all([
      waitForReply(config, 100),
      waitForReply(config, 200, ac.signal),
    ]);
    expect(replyA).toBe("Only A");
    expect(replyB).toBeNull();
  });
});

describe("edge cases — message filtering", () => {
  it("ignores messages from wrong chat ID", async () => {
    let pollCount = 0;

    setHandler((req, res) => {
      const url = parseUrl(req);
      if (!url.pathname.includes("/getUpdates")) return;

      pollCount++;
      if (pollCount === 1) {
        jsonResponse(res, {
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 300,
                chat: { id: 999 }, // wrong chat
                text: "Wrong chat",
                reply_to_message: { message_id: 100 },
              },
            },
          ],
        });
      } else if (pollCount === 2) {
        jsonResponse(res, {
          ok: true,
          result: [
            {
              update_id: 2,
              message: {
                message_id: 301,
                chat: { id: 123 }, // right chat
                text: "Right chat",
                reply_to_message: { message_id: 100 },
              },
            },
          ],
        });
      } else {
        jsonResponse(res, { ok: true, result: [] });
      }
    });

    const reply = await waitForReply(config, 100);
    expect(reply).toBe("Right chat");
  });

  it("ignores whitespace-only text replies", async () => {
    let pollCount = 0;

    setHandler((req, res) => {
      const url = parseUrl(req);
      if (!url.pathname.includes("/getUpdates")) return;

      pollCount++;
      if (pollCount === 1) {
        jsonResponse(res, {
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 300,
                chat: { id: 123 },
                text: "   \n  ",
                reply_to_message: { message_id: 100 },
              },
            },
          ],
        });
      } else if (pollCount === 2) {
        jsonResponse(res, {
          ok: true,
          result: [
            {
              update_id: 2,
              message: {
                message_id: 301,
                chat: { id: 123 },
                text: "Real response",
                reply_to_message: { message_id: 100 },
              },
            },
          ],
        });
      } else {
        jsonResponse(res, { ok: true, result: [] });
      }
    });

    const reply = await waitForReply(config, 100);
    expect(reply).toBe("Real response");
  });

  it("ignores empty document files", async () => {
    let pollCount = 0;

    setHandler((req, res) => {
      const url = parseUrl(req);

      if (url.pathname.includes("/getUpdates")) {
        pollCount++;
        if (pollCount === 1) {
          jsonResponse(res, {
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 300,
                  chat: { id: 123 },
                  document: { file_id: "empty-file" },
                  reply_to_message: { message_id: 100 },
                },
              },
            ],
          });
        } else if (pollCount === 2) {
          jsonResponse(res, {
            ok: true,
            result: [
              {
                update_id: 2,
                message: {
                  message_id: 301,
                  chat: { id: 123 },
                  text: "Fallback text",
                  reply_to_message: { message_id: 100 },
                },
              },
            ],
          });
        } else {
          jsonResponse(res, { ok: true, result: [] });
        }
        return;
      }

      if (url.pathname.includes("/getFile")) {
        jsonResponse(res, { ok: true, result: { file_path: "docs/empty.txt" } });
        return;
      }

      if (url.pathname.includes("/file/")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("   "); // whitespace only
        return;
      }
    });

    const reply = await waitForReply(config, 100);
    expect(reply).toBe("Fallback text");
  });

  it("skips updates without a message field", async () => {
    let pollCount = 0;

    setHandler((req, res) => {
      const url = parseUrl(req);
      if (!url.pathname.includes("/getUpdates")) return;

      pollCount++;
      if (pollCount === 1) {
        jsonResponse(res, {
          ok: true,
          result: [
            { update_id: 1 }, // no message
            { update_id: 2, message: null }, // null message
            {
              update_id: 3,
              message: {
                message_id: 300,
                chat: { id: 123 },
                text: "Valid",
                reply_to_message: { message_id: 100 },
              },
            },
          ],
        });
      } else {
        jsonResponse(res, { ok: true, result: [] });
      }
    });

    const reply = await waitForReply(config, 100);
    expect(reply).toBe("Valid");
  });

  it("handles multiple updates in a single poll response", async () => {
    let pollCount = 0;

    setHandler((req, res) => {
      const url = parseUrl(req);
      if (!url.pathname.includes("/getUpdates")) return;

      pollCount++;
      if (pollCount === 1) {
        jsonResponse(res, {
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 300,
                chat: { id: 123 },
                text: "Irrelevant",
                reply_to_message: { message_id: 999 },
              },
            },
            {
              update_id: 2,
              message: {
                message_id: 301,
                chat: { id: 123 },
                text: "The one we want",
                reply_to_message: { message_id: 100 },
              },
            },
            {
              update_id: 3,
              message: {
                message_id: 302,
                chat: { id: 123 },
                text: "After the match",
                reply_to_message: { message_id: 100 },
              },
            },
          ],
        });
      } else {
        jsonResponse(res, { ok: true, result: [] });
      }
    });

    const reply = await waitForReply(config, 100);
    expect(reply).toBe("The one we want");
  });
});

describe("edge cases — polling lifecycle", () => {
  it("restarts polling after all listeners gone and new waiter arrives", async () => {
    let pollCount = 0;

    setHandler((req, res) => {
      const url = parseUrl(req);
      if (!url.pathname.includes("/getUpdates")) return;

      pollCount++;
      if (pollCount === 1) {
        jsonResponse(res, {
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 300,
                chat: { id: 123 },
                text: "First round",
                reply_to_message: { message_id: 100 },
              },
            },
          ],
        });
      } else if (pollCount >= 3) {
        // After restart, eventually return a reply
        jsonResponse(res, {
          ok: true,
          result: [
            {
              update_id: 2,
              message: {
                message_id: 301,
                chat: { id: 123 },
                text: "Second round",
                reply_to_message: { message_id: 200 },
              },
            },
          ],
        });
      } else {
        jsonResponse(res, { ok: true, result: [] });
      }
    });

    // First waiter — polling starts, resolves, polling stops (no listeners)
    const reply1 = await waitForReply(config, 100);
    expect(reply1).toBe("First round");

    // Wait a tick for the no-listeners check to stop polling
    await new Promise((r) => setTimeout(r, 100));

    // Second waiter — polling should restart
    const reply2 = await waitForReply(config, 200);
    expect(reply2).toBe("Second round");
  });

  it("malformed JSON triggers backoff, then recovers", async () => {
    let requestCount = 0;
    const timestamps: number[] = [];

    setHandler((req, res) => {
      const url = parseUrl(req);
      if (!url.pathname.includes("/getUpdates")) return;

      requestCount++;
      timestamps.push(Date.now());

      if (requestCount === 1) {
        // Return invalid JSON with 200 status
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("this is not json<html>502 bad gateway</html>");
        return;
      }

      jsonResponse(res, {
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 300,
              chat: { id: 123 },
              text: "Recovered",
              reply_to_message: { message_id: 100 },
            },
          },
        ],
      });
    });

    const reply = await waitForReply(config, 100);
    expect(reply).toBe("Recovered");
    expect(requestCount).toBe(2);
    // Should have backed off ~2s (first error)
    const gap = timestamps[1]! - timestamps[0]!;
    expect(gap).toBeGreaterThanOrEqual(1800);
  }, 10_000);

  it("document download exhausts all retries — waiter is not stuck forever", async () => {
    let pollCount = 0;
    const ac = new AbortController();

    setHandler((req, res) => {
      const url = parseUrl(req);

      if (url.pathname.includes("/getUpdates")) {
        pollCount++;
        if (pollCount === 1) {
          jsonResponse(res, {
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 300,
                  chat: { id: 123 },
                  document: { file_id: "doomed-file" },
                  reply_to_message: { message_id: 100 },
                },
              },
            ],
          });
        } else {
          jsonResponse(res, { ok: true, result: [] });
        }
        return;
      }

      if (url.pathname.includes("/getFile")) {
        // Always fail
        res.destroy();
        return;
      }
    });

    // The download will fail 3x, reply is lost.
    // Abort after 15s so the test doesn't hang forever — this verifies
    // the waiter doesn't resolve with the lost reply.
    setTimeout(() => ac.abort(), 12_000);
    const reply = await waitForReply(config, 100, ac.signal);
    expect(reply).toBeNull();
  }, 20_000);
});

describe("polling — abort signal", () => {
  it("resolves null when signal is aborted", async () => {
    const ac = new AbortController();

    setHandler((_req, res) => {
      // Slow poll — never returns a reply
      jsonResponse(res, { ok: true, result: [] });
    });

    // Abort after 200ms
    setTimeout(() => ac.abort(), 200);

    const reply = await waitForReply(config, 100, ac.signal);
    expect(reply).toBeNull();
  });

  it("resolves null immediately if signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();

    const reply = await waitForReply(config, 100, ac.signal);
    expect(reply).toBeNull();
  });
});
