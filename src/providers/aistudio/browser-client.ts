/** Run on the signed-in https://aistudio.google.com page. Keep this handle private. */
export interface AIStudioConnection {
  url: string;
  token: string;
}
export function connectAIStudioBrowser(
  connection: AIStudioConnection,
  options: { fetch?: typeof fetch; WebSocket?: typeof WebSocket } = {},
): () => void {
  const endpoint = new URL(connection.url);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.pathname !== "/v1/ws" ||
    endpoint.search ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("Expected a private loopback relay URL");
  }
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  const socket = new Socket(endpoint.href);
  const requests = new Map<string, AbortController>();
  const send = (id: string, type: string, payload: unknown = {}) => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({ id, type, payload }));
    }
  };
  socket.onopen = () =>
    socket.send(JSON.stringify({ type: "auth", payload: { token: connection.token } }));
  socket.onmessage = async (event) => {
    let message: any;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const { id, type, payload } = message;
    if (type === "ping") {
      send(id, "pong");
      return;
    }
    if (type === "cancel") {
      requests.get(id)?.abort();
      return;
    }
    if (type !== "http_request" || typeof id !== "string" || requests.has(id)) {
      return;
    }
    const controller = new AbortController();
    requests.set(id, controller);
    try {
      const url = new URL(payload.url);
      if (
        url.origin !== "https://generativelanguage.googleapis.com" ||
        !/^\/v1beta\/models(?:\/[\w.-]+:(?:generateContent|streamGenerateContent|countTokens|embedContent|batchEmbedContents))?$/.test(
          url.pathname,
        )
      ) {
        throw new Error("Forbidden relay target");
      }
      if (!["GET", "POST"].includes(payload.method)) {
        throw new Error("Forbidden relay method");
      }
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: payload.method,
        headers: { "Content-Type": "application/json" },
        body: payload.method === "POST" ? payload.body : undefined,
        credentials: "include",
        redirect: "error",
        signal: controller.signal,
      });
      const headers = Object.fromEntries(response.headers);
      if (
        response.body &&
        (response.headers.get("content-type")?.includes("text/event-stream") ||
          (response.ok && url.pathname.endsWith(":streamGenerateContent")))
      ) {
        send(id, "stream_start", { status: response.status, headers });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          while (
            socket.bufferedAmount > 1024 * 1024 &&
            socket.readyState === 1 &&
            !controller.signal.aborted
          ) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          controller.signal.throwIfAborted();
          send(id, "stream_chunk", { data: decoder.decode(chunk.value, { stream: true }) });
        }
        const tail = decoder.decode();
        if (tail) {
          send(id, "stream_chunk", { data: tail });
        }
        send(id, "stream_end");
      } else {
        send(id, "http_response", {
          status: response.status,
          headers,
          body: await response.text(),
        });
      }
    } catch {
      send(id, "error", {
        error: "Browser request failed; check the signed-in browser session and network access.",
      });
    } finally {
      requests.delete(id);
    }
  };
  const cancel = () => {
    for (const request of requests.values()) {
      request.abort();
    }
    requests.clear();
  };
  socket.onclose = cancel;
  return () => {
    cancel();
    socket.close();
  };
}
