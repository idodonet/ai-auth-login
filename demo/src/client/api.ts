import type {
  Bootstrap,
  ChatEvent,
  ChatRequest,
  Result,
  SessionEvent,
  SessionView,
  TabAction,
} from "../shared/types";

let token = "";
export async function bootstrap(): Promise<Bootstrap> {
  const value = await request<Bootstrap>("/api/bootstrap");
  token = value.token;
  return value;
}
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-Demo-Token": token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = (await response.json()) as Result<T>;
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}
export function action(id: string, body: TabAction): Promise<SessionView> {
  return request(`/api/tabs/${encodeURIComponent(id)}/action`, body);
}
async function lines(response: Response, signal: AbortSignal, consume: (line: string) => void) {
  if (!response.ok || !response.body) {
    throw new Error(`Connection failed (${response.status}).`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        consume(line.replace(/\r$/, ""));
      }
      if (done) {
        if (buffer) {
          consume(buffer);
        }
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function events(signal: AbortSignal, consume: (event: SessionEvent) => void) {
  const response = await fetch("/api/events", {
    headers: { "X-Demo-Token": token },
    signal,
  });
  await lines(response, signal, (line) => {
    if (line.startsWith("data:")) {
      consume(JSON.parse(line.slice(5)) as SessionEvent);
    }
  });
  if (!signal.aborted) {
    throw new Error("The session connection closed. Reconnect to continue.");
  }
}
export async function chat(
  id: string,
  body: ChatRequest,
  signal: AbortSignal,
  consume: (event: ChatEvent) => void,
) {
  const response = await fetch(`/api/tabs/${encodeURIComponent(id)}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Demo-Token": token },
    body: JSON.stringify(body),
    signal,
  });
  let terminal = false;
  await lines(response, signal, (line) => {
    if (!line.trim() || terminal) {
      return;
    }
    const event = JSON.parse(line) as ChatEvent;
    terminal = event.type === "done" || event.type === "error";
    consume(event);
  });
  if (!terminal && !signal.aborted) {
    throw new Error("The response stream ended before completion.");
  }
}

export async function relayHelper(): Promise<string> {
  const response = await fetch("/api/aistudio-helper.js", {
    headers: { "X-Demo-Token": token },
  });
  if (!response.ok) {
    throw new Error("Could not load the local AI Studio helper.");
  }
  return response.text();
}
