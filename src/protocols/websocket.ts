import WebSocket from "ws";
import { fail, ok } from "../result.js";
import type { Result } from "../types.js";

export async function connectResponsesSocket(
  base: string,
  headers: Headers,
  signal: AbortSignal,
): Promise<Result<WebSocket>> {
  if (signal.aborted) return fail("cancelled", "WebSocket connection cancelled.");
  const url = new URL(`${base}/responses`);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const socket = new WebSocket(url, {
    headers: Object.fromEntries(headers),
    handshakeTimeout: 30000,
    followRedirects: false,
    maxPayload: 16 * 1024 * 1024,
  });
  const abort = () => socket.terminate();
  signal.addEventListener("abort", abort, { once: true });
  socket.once("close", () => signal.removeEventListener("abort", abort));
  // Session cancellation can emit an error after a caller has removed its listeners.
  socket.on("error", () => {});
  return new Promise((resolve) => {
    socket.once("open", () => resolve(ok(socket)));
    socket.once("error", () =>
      resolve(
        fail(
          signal.aborted ? "cancelled" : "network-error",
          "Responses WebSocket connection failed.",
          !signal.aborted,
        ),
      ),
    );
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(
        fail(
          response.statusCode === 401 || response.statusCode === 403
            ? "auth-required"
            : response.statusCode === 404 || response.statusCode === 405
              ? "unsupported"
              : "provider-error",
          "Responses WebSocket upgrade rejected.",
        ),
      );
    });
    socket.once("close", () =>
      resolve(
        fail(
          signal.aborted ? "cancelled" : "network-error",
          "Responses WebSocket closed before opening.",
        ),
      ),
    );
  });
}
