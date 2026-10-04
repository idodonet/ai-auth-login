export interface SSEEvent {
  event: string;
  data: string;
}

/** Incremental UTF-8 SSE parsing, including CRLF and multiline data. */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    event = "",
    data: string[] = [];
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buffer && !/[\r\n]$/.test(buffer)) {
        buffer += "\n";
      }
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        if (!done && match[0] === "\r" && match.index === buffer.length - 1) {
          break;
        }
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (!line) {
          if (data.length) {
            yield { event: event || "message", data: data.join("\n") };
          }
          event = "";
          data = [];
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const raw = colon < 0 ? "" : line.slice(colon + 1);
          const text = raw.startsWith(" ") ? raw.slice(1) : raw;
          if (field === "event") {
            event = text;
          }
          if (field === "data") {
            data.push(text);
          }
        }
      }
      if (done) {
        if (data.length) {
          yield { event: event || "message", data: data.join("\n") };
        }
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function encodeSSE(event: string | undefined, data: unknown): Uint8Array {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return new TextEncoder().encode(
    `${event ? `event: ${event}\n` : ""}${text
      .split("\n")
      .map((line) => `data: ${line}\n`)
      .join("")}\n`,
  );
}

export function streamSSE(
  events: AsyncGenerator<Uint8Array>,
  upstream?: Response,
  onCancel?: () => void,
): Response {
  const headers = new Headers(upstream?.headers);
  for (const key of ["content-length", "content-encoding", "transfer-encoding"]) {
    headers.delete(key);
  }
  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-cache");
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await events.next();
          if (next.done) {
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        onCancel?.();
        await events.return(undefined);
      },
    }),
    { status: upstream?.status ?? 200, headers },
  );
}
