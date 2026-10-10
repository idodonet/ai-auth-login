import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { ProviderAdapter, CredentialState } from "../contract.js";
import { ok, fail } from "../../result.js";
import type { AIStudioConnection } from "./browser-client.js";
import { geminiCountBody, executeGemini } from "../../protocols/gemini.js";
export { connectAIStudioBrowser } from "./browser-client.js";
export type { AIStudioConnection } from "./browser-client.js";

interface Pending {
  receive(message: any): void;
  fail(error: Error): void;
}
export function createProvider(): ProviderAdapter {
  let server: Server | undefined;
  let sockets: WebSocketServer | undefined;
  let browser: WebSocket | undefined;
  let connection: AIStudioConnection | null = null;
  const pending = new Map<string, Pending>();
  const disconnect = () => {
    browser = undefined;
    for (const request of [...pending.values()]) {
      request.fail(new Error("AI Studio browser disconnected"));
    }
  };
  async function start(token = randomBytes(32).toString("hex")) {
    if (server) {
      return;
    }
    server = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    server.on("upgrade", (req, socket, head) => {
      if (req.url !== "/v1/ws" || req.headers.origin !== "https://aistudio.google.com") {
        socket.destroy();
        return;
      }
      sockets!.handleUpgrade(req, socket, head, (ws) => {
        let authenticated = false;
        let alive = true;
        const heartbeat = setInterval(() => {
          if (!alive) {
            ws.terminate();
            return;
          }
          alive = false;
          ws.ping();
        }, 30_000);
        heartbeat.unref();
        ws.on("pong", () => {
          alive = true;
        });
        const timeout = setTimeout(() => ws.terminate(), 5000);
        timeout.unref();
        ws.on("close", () => {
          clearTimeout(timeout);
          clearInterval(heartbeat);
          if (browser === ws) {
            disconnect();
          }
        });
        ws.on("error", () => ws.terminate());
        ws.on("message", (raw) => {
          let message: any;
          try {
            message = JSON.parse(raw.toString());
          } catch {
            ws.close(1008);
            return;
          }
          if (!authenticated) {
            const supplied = message?.payload?.token;
            if (
              message?.type !== "auth" ||
              typeof supplied !== "string" ||
              Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
              !timingSafeEqual(Buffer.from(supplied), Buffer.from(token)) ||
              browser
            ) {
              ws.close(1008);
              return;
            }
            authenticated = true;
            clearTimeout(timeout);
            browser = ws;
            ws.send(JSON.stringify({ type: "auth_ok" }));
            return;
          }
          if (message.type === "ping") {
            ws.send(JSON.stringify({ id: message.id, type: "pong" }));
            return;
          }
          if (typeof message.id === "string") {
            pending.get(message.id)?.receive(message);
          }
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Relay listener unavailable");
    }
    connection = { url: `ws://127.0.0.1:${address.port}/v1/ws`, token };
  }
  const relayFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== "https://generativelanguage.googleapis.com" ||
      !/^\/v1beta\/models(?:\/[\w.-]+:(?:generateContent|streamGenerateContent|countTokens|embedContent|batchEmbedContents))?$/.test(
        url.pathname,
      )
    ) {
      throw new Error("Forbidden relay target");
    }
    if (!browser || browser.readyState !== WebSocket.OPEN) {
      throw new Error("Connect the signed-in AI Studio browser companion first");
    }
    const body = request.method === "POST" ? await request.text() : "";
    if (Buffer.byteLength(body) > 8 * 1024 * 1024) {
      throw new Error("Relay request exceeds 8 MiB");
    }
    const ws = browser;
    const id = randomUUID();
    return new Promise<Response>((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        pending.delete(id);
      };
      const failure = (error: Error) => {
        cleanup();
        if (settled) {
          controller?.error(error);
        } else {
          reject(error);
        }
      };
      const cancel = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id, type: "cancel" }));
        }
      };
      const abort = () => {
        cancel();
        failure(new Error("Relay request cancelled"));
      };
      const timer = setTimeout(() => {
        cancel();
        failure(new Error("Relay request timed out"));
      }, 120_000);
      timer.unref();
      const headers = (value: unknown) => {
        const result = new Headers();
        if (value && typeof value === "object") {
          for (const [key, item] of Object.entries(value)) {
            if (typeof item === "string") {
              result.set(key, item);
            } else if (Array.isArray(item)) {
              for (const v of item) {
                if (typeof v === "string") {
                  result.append(key, v);
                }
              }
            }
          }
        }
        result.delete("content-length");
        result.delete("content-encoding");
        return result;
      };
      pending.set(id, {
        fail: failure,
        receive(message) {
          const payload = message.payload ?? {};
          try {
            if (message.type === "error") {
              failure(new Error("AI Studio browser request failed"));
              return;
            }
            if (message.type === "http_response" || message.type === "stream_start") {
              if (
                settled ||
                !Number.isInteger(payload.status) ||
                payload.status < 200 ||
                payload.status > 599
              ) {
                throw new Error("Invalid relay response");
              }
              settled = true;
              if (message.type === "http_response") {
                if (typeof payload.body !== "string") {
                  throw new Error("Invalid relay body");
                }
                cleanup();
                resolve(
                  new Response(
                    payload.status === 204 || payload.status === 205 || payload.status === 304
                      ? null
                      : payload.body,
                    { status: payload.status, headers: headers(payload.headers) },
                  ),
                );
              } else {
                resolve(
                  new Response(
                    new ReadableStream<Uint8Array>(
                      {
                        start(c) {
                          controller = c;
                        },
                        cancel() {
                          cancel();
                          cleanup();
                        },
                      },
                      { highWaterMark: 8 * 1024 * 1024, size: (chunk) => chunk.byteLength },
                    ),
                    { status: payload.status, headers: headers(payload.headers) },
                  ),
                );
              }
            } else if (message.type === "stream_chunk") {
              if (!controller || typeof payload.data !== "string") {
                throw new Error("Invalid relay stream");
              }
              // ponytail: bounded 8 MiB queue; cancel slow consumers rather than retain unbounded browser data.
              if ((controller.desiredSize ?? 0) < payload.data.length) {
                cancel();
                throw new Error("Relay stream consumer too slow");
              }
              controller.enqueue(new TextEncoder().encode(payload.data));
            } else if (message.type === "stream_end") {
              if (!controller) {
                throw new Error("Invalid relay stream");
              }
              controller.close();
              cleanup();
            }
          } catch (error) {
            failure(error instanceof Error ? error : new Error("Invalid relay message"));
          }
        },
      });
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) {
        abort();
        return;
      }
      ws.send(
        JSON.stringify({
          id,
          type: "http_request",
          payload: {
            method: request.method,
            url: request.url,
            headers: { "Content-Type": ["application/json"] },
            body,
            sent_at: new Date().toISOString(),
          },
        }),
        (error) => {
          if (error) {
            failure(error);
          }
        },
      );
    });
  };
  const adapter: ProviderAdapter = {
    descriptor: {
      id: "aistudio",
      name: "AI Studio",
      authMethods: ["relay"],
      endpoints: ["models", "chat.completions", "responses", "count_tokens", "generateContent"],
      quota: false,
      modelDiscovery: "live",
    },
    beginAuth: async () =>
      fail(
        "unsupported",
        'AI Studio uses connect({ kind: "relay" }) and a signed-in browser companion.',
      ),
    async connect(input) {
      if (input.kind !== "relay") {
        return fail("unsupported", "AI Studio requires relay credentials.");
      }
      if (input.url) {
        return fail(
          "unsupported",
          "External relays are not supported; omit url to create a private loopback listener.",
        );
      }
      await adapter.close?.();
      try {
        await start();
        return ok({
          provider: "aistudio",
          authenticatedAt: new Date().toISOString(),
          credentials: { token: connection!.token, url: connection!.url },
        });
      } catch {
        return fail("provider-error", "Unable to start the private AI Studio relay.");
      }
    },
    async checkAuth(state) {
      if (
        typeof state.credentials.token !== "string" ||
        !/^[a-f0-9]{64}$/.test(state.credentials.token)
      ) {
        return fail("auth-required", "Invalid AI Studio relay state.");
      }
      try {
        await start(state.credentials.token);
      } catch {
        return fail("provider-error", "Unable to restore the private AI Studio relay.");
      }
      const updated: CredentialState = {
        ...state,
        credentials: { ...state.credentials, url: connection!.url },
      };
      return browser?.readyState === WebSocket.OPEN
        ? ok(updated)
        : fail("auth-required", "Reconnect the signed-in browser companion using getConnection().");
    },
    getConnection: () => connection,
    getAccount: async (state) =>
      ok({
        id: null,
        email: null,
        plan: null,
        isFree: null,
        lastAuthenticatedAt: state.authenticatedAt,
      }),
    getQuota: async () =>
      ok({ supported: false, checkedAt: new Date().toISOString(), windows: [] }),
    async listModels(_state, context) {
      try {
        const models: { id: string; object: "model"; created: number; owned_by: string }[] = [];
        let pageToken = "";
        const seen = new Set<string>();
        do {
          const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
          if (pageToken) url.searchParams.set("pageToken", pageToken);
          const response = await relayFetch(url, { signal: context.signal });
          if (!response.ok) return fail("provider-error", "AI Studio model discovery failed.");
          const data = (await response.json()) as {
            models?: { name?: unknown; supportedGenerationMethods?: unknown }[];
            nextPageToken?: unknown;
          };
          if (!Array.isArray(data.models))
            return fail("provider-error", "AI Studio returned an invalid model list.");
          for (const model of data.models) {
            if (
              typeof model?.name === "string" &&
              Array.isArray(model.supportedGenerationMethods) &&
              model.supportedGenerationMethods.includes("generateContent")
            ) {
              models.push({
                id: model.name.replace(/^models\//, ""),
                object: "model",
                created: 0,
                owned_by: "google",
              });
            }
          }
          pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
          if (pageToken && seen.has(pageToken))
            return fail("provider-error", "AI Studio returned a repeated model page.");
          seen.add(pageToken);
        } while (pageToken);
        return ok(models);
      } catch {
        return fail(
          "network-error",
          "Connect the AI Studio browser companion to retrieve models.",
          true,
        );
      }
    },
    async execute(request, _state, context) {
      return executeGemini(request, async (body, signal, action) => {
        const { model, stream, ...payload } = body;
        const config = payload.generationConfig as
          { thinkingConfig?: { thinkingLevel?: unknown } } | undefined;
        const level = config?.thinkingConfig?.thinkingLevel;
        if (
          typeof level === "string" &&
          ["minimal", "low", "medium", "high"].includes(level.toLowerCase())
        ) {
          config!.thinkingConfig!.thinkingLevel = level.toUpperCase();
        }
        if (typeof model !== "string" || !/^[\w.-]+$/.test(model)) {
          throw new Error("Invalid AI Studio model");
        }
        return relayFetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:${action === "count" ? "countTokens" : stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(action === "count" ? geminiCountBody(model, payload) : payload),
            signal: AbortSignal.any([signal, context.signal]),
          },
        );
      });
    },
    async close() {
      for (const item of [...pending.values()]) {
        item.fail(new Error("AI Studio relay closed"));
      }
      for (const ws of sockets?.clients ?? []) {
        ws.terminate();
      }
      browser = undefined;
      sockets?.close();
      sockets = undefined;
      const current = server;
      server = undefined;
      connection = null;
      if (current) {
        await new Promise<void>((resolve) => current.close(() => resolve()));
      }
    },
  };
  return adapter;
}
