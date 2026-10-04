import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";
import { once } from "node:events";
import { ProviderSession } from "ai-auth-login";
import { failure, SessionManager } from "./sessions.js";
import { validAction, validChat } from "./validation.js";
import type { SessionEvent } from "../shared/types.js";

interface ServerOptions {
  port?: number;
  clientDirectory?: string;
  disconnectGraceMs?: number;
  sessionFactory?: (state?: string) => ProviderSession;
}
export function createDemoServer(options: ServerOptions = {}) {
  const token = randomBytes(32).toString("hex");
  const feeds = new Set<ServerResponse>();
  let cleanup: ReturnType<typeof setTimeout> | undefined;
  const broadcast = (event: SessionEvent) => {
    for (const feed of feeds) {
      if (feed.writableLength > 1024 * 1024) {
        feed.destroy();
      } else {
        feed.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
  };
  const manager = new SessionManager(broadcast, options.sessionFactory);
  const clientDirectory =
    options.clientDirectory ?? fileURLToPath(new URL("../client/", import.meta.url));
  const reply = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
  };
  async function body(request: IncomingMessage): Promise<unknown> {
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      throw new Error("Invalid content type");
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 1_048_576) {
        throw new Error("Body too large");
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const server = createServer(async (request, response) => {
    try {
      const port =
        typeof server.address() === "object"
          ? (server.address() as { port: number } | null)?.port
          : options.port;
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
      if (process.env.DEMO_ORIGIN) {
        origins.add(process.env.DEMO_ORIGIN);
      }
      const origin = request.headers.origin;
      if (
        !hosts.has(request.headers.host ?? "") ||
        (origin !== undefined && !origins.has(origin)) ||
        (!origin && request.headers["sec-fetch-site"] === "cross-site")
      ) {
        reply(response, 403, failure("Forbidden local request."));
        return;
      }
      if (origin) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Headers": "Content-Type, X-Demo-Token",
          "Access-Control-Allow-Methods": "GET, POST",
        });
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname.startsWith("/api/")) {
        response.setHeader("Cache-Control", "no-store");
        if (request.method === "GET" && url.pathname === "/api/bootstrap") {
          reply(response, 200, {
            ok: true,
            value: { providers: ProviderSession.listProviders(), token },
          });
          return;
        }
        const supplied = request.headers["x-demo-token"];
        if (
          typeof supplied !== "string" ||
          supplied.length !== token.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
        ) {
          reply(response, 403, failure("Invalid demo token."));
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/aistudio-helper.js") {
          const helper = await readFile(
            fileURLToPath(import.meta.resolve("ai-auth-login/aistudio-browser")),
            "utf8",
          );
          response.writeHead(200, {
            "Content-Type": "text/javascript",
            "X-Content-Type-Options": "nosniff",
          });
          response.end(
            helper.replace(
              "export function connectAIStudioBrowser",
              "function connectAIStudioBrowser",
            ) + "\nglobalThis.connectAIStudioBrowser = connectAIStudioBrowser;\n",
          );
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/events") {
          clearTimeout(cleanup);
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          response.write(": connected\n\n");
          feeds.add(response);
          for (const session of manager.snapshots()) {
            response.write(
              `data: ${JSON.stringify({ type: "session", tabId: session.id, session })}\n\n`,
            );
          }
          const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
          response.on("close", () => {
            clearInterval(heartbeat);
            feeds.delete(response);
            if (!feeds.size) {
              cleanup = setTimeout(() => {
                void manager.close();
              }, options.disconnectGraceMs ?? 15_000);
            }
          });
          return;
        }
        const match = /^\/api\/tabs\/([\w-]{1,80})\/(action|chat)$/.exec(url.pathname);
        if (request.method === "POST" && match) {
          const input = await body(request);
          const id = match[1]!;
          if (match[2] === "action") {
            if (!validAction(input)) {
              reply(response, 400, failure("Invalid session action."));
              return;
            }
            reply(response, 200, await manager.action(id, input));
            return;
          }
          if (!validChat(input)) {
            reply(response, 400, failure("Invalid chat request."));
            return;
          }
          const controller = new AbortController();
          response.on("close", () => controller.abort());
          response.writeHead(200, {
            "Content-Type": "application/x-ndjson",
            "X-Content-Type-Options": "nosniff",
          });
          await manager.chat(id, input, controller.signal, async (event) => {
            if (response.destroyed) {
              return;
            }
            if (!response.write(JSON.stringify(event) + "\n")) {
              await once(response, "drain", { signal: controller.signal });
            }
          });
          response.end();
          return;
        }
        reply(response, 404, failure("API route not found."));
        return;
      }
      if (request.method !== "GET") {
        reply(response, 405, failure("Method not allowed."));
        return;
      }
      const requested = resolve(clientDirectory, "." + decodeURIComponent(url.pathname));
      if (
        requested !== resolve(clientDirectory) &&
        !requested.startsWith(resolve(clientDirectory) + sep)
      ) {
        reply(response, 403, failure("Forbidden path."));
        return;
      }
      const path = extname(requested) ? requested : resolve(clientDirectory, "index.html");
      try {
        const content = await readFile(path);
        const mime: Record<string, string> = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        };
        response.writeHead(200, {
          "Content-Type": mime[extname(path)] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(content);
      } catch {
        reply(
          response,
          404,
          failure(
            "Client build unavailable. Run npm run build, or open the Vite development server on port 4317.",
          ),
        );
      }
    } catch {
      if (!response.headersSent) {
        reply(response, 400, failure("Request could not be processed."));
      } else {
        response.end();
      }
    }
  });
  server.requestTimeout = 130_000;
  return {
    server,
    manager,
    token,
    async close() {
      clearTimeout(cleanup);
      for (const feed of feeds) {
        feed.destroy();
      }
      await manager.close();
      clearTimeout(cleanup);
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  };
}
