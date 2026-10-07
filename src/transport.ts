import type { ProviderError, SessionStats } from "./types.js";

export function errorResponse(
  error: ProviderError,
  status = error.code === "auth-required" ? 401 : error.code === "unsupported" ? 400 : 503,
): Response {
  return Response.json(
    { error: { message: error.message, type: error.code, code: error.code, param: null } },
    { status },
  );
}

/** Counts network attempts, not SDK calls. Metadata uses an unwrapped fetch. */
export function countedFetch(
  fetch: typeof globalThis.fetch,
  stats: SessionStats,
): typeof globalThis.fetch & { markFailure(): void } {
  let lastFailure = () => {};
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    stats.requestsSent++;
    let failed = false;
    let terminal = false;
    let cancelled = false;
    const failOnce = () => {
      if (!failed) {
        failed = true;
        stats.requestsFailed++;
      }
    };
    lastFailure = failOnce;
    try {
      const response = await fetch(input, init);
      if (!response.ok) {
        failOnce();
      }
      if (!response.body) {
        return response;
      }
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const reader = response.body.getReader();
      let isSSE: boolean | undefined = response.headers
        .get("content-type")
        ?.includes("text/event-stream")
        ? true
        : undefined;
      const decoder = new TextDecoder();
      let pending = "";
      const onAbort = () => {
        if (!terminal) {
          failOnce();
        }
        void reader.cancel(signal?.reason).catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
      const done = () => signal?.removeEventListener("abort", onAbort);
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (cancelled) return;
            if (chunk.done) {
              done();
              controller.close();
              return;
            }
            if (isSSE !== false) {
              pending += decoder.decode(chunk.value, { stream: true });
              if (isSSE === undefined && pending.trimStart()) {
                isSSE = /^[deir:]/.test(pending.trimStart());
              }
              if (isSSE === false) pending = "";
              const frames = pending.split(/\r?\n\r?\n/);
              pending = frames.pop() ?? "";
              // ponytail: cap incomplete SSE frames at 16 MiB; larger providers need configurable limits.
              if (pending.length > 16 * 1024 * 1024) {
                throw new Error("Provider SSE frame exceeds 16 MiB.");
              }
              for (const frame of frames) {
                if (/^event:\s*error\s*$/m.test(frame)) {
                  failOnce();
                }
                for (const line of frame.split(/\r?\n/)) {
                  if (!line.startsWith("data:")) {
                    continue;
                  }
                  if (line.slice(5).trim() === "[DONE]") {
                    terminal = true;
                  }
                  try {
                    const event = JSON.parse(line.slice(5));
                    if (
                      event.type === "response.completed" ||
                      event.type === "response.incomplete" ||
                      event.type === "message_stop" ||
                      event.choices?.some(
                        (choice: { finish_reason?: unknown }) => choice.finish_reason,
                      )
                    ) {
                      terminal = true;
                    }
                    if (event.error || event.type === "error" || event.type === "response.failed") {
                      failOnce();
                    }
                  } catch {}
                }
              }
            }
            controller.enqueue(chunk.value);
          } catch (error) {
            if (cancelled) return;
            failOnce();
            done();
            controller.error(error);
          }
        },
        async cancel(reason) {
          cancelled = true;
          if (!terminal) {
            failOnce();
          }
          done();
          await reader.cancel(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      failOnce();
      throw error;
    }
  };
  return Object.assign(wrapped, { markFailure: () => lastFailure() });
}

/** Holds request ownership until the caller consumes or cancels its stream. */
export function ownResponse(
  response: Response,
  finish: () => void,
  signal: AbortSignal,
  failed: () => void = () => {},
): Response {
  if (!response.body) {
    finish();
    return response;
  }
  const reader = response.body.getReader();
  let ended = false;
  const end = () => {
    if (!ended) {
      ended = true;
      signal.removeEventListener("abort", abort);
      finish();
    }
  };
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
    end();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (signal.aborted) {
            throw signal.reason;
          }
          if (chunk.done) {
            end();
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          failed();
          end();
          controller.error(error);
        }
      },
      async cancel(reason) {
        end();
        await reader.cancel(reason);
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}
