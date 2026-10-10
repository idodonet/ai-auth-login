import { getEncoding } from "js-tiktoken";
import { requestBody, protocolError } from "./openai.js";

const encoders = new Map<string, ReturnType<typeof getEncoding>>();
/** CLIProxyAPI's local text/schema estimate; excludes image/audio and wire overhead. */
export async function estimateTokens(request: Request): Promise<Response> {
  if (request.method !== "POST") return protocolError("Token counting requires POST", 405);
  const body = await requestBody(request);
  if (body instanceof Response) return body;
  if (
    typeof body.model !== "string" ||
    !Array.isArray(body.messages) ||
    body.messages.some((message) => !message || typeof message !== "object")
  ) {
    return protocolError("Token counting requires a model and messages");
  }
  if (request.signal.aborted) request.signal.throwIfAborted();
  const name = /^(?:gpt-(?:5|6|4o|4\.1)|grok|meta)/.test(body.model) ? "o200k_base" : "cl100k_base";
  let encoder = encoders.get(name);
  if (!encoder) {
    encoder = getEncoding(name);
    encoders.set(name, encoder);
  }
  const parts: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  };
  try {
    if (typeof body.system === "string") add(body.system);
    else for (const part of body.system ?? []) add(part.text);
    for (const message of body.messages) {
      if (typeof message.content === "string") add(message.content);
      else
        for (const part of message.content ?? []) {
          add(part.text);
          if (part.type === "tool_use") {
            add(part.name);
            add(JSON.stringify(part.input ?? {}));
          }
          if (part.type === "tool_result") {
            if (typeof part.content === "string") add(part.content);
            else for (const value of part.content ?? []) add(value.text);
          }
        }
      for (const call of message.tool_calls ?? []) {
        add(call.function?.name);
        add(call.function?.arguments);
      }
    }
    for (const tool of body.tools ?? []) {
      const fn = tool.function ?? tool;
      add(fn.name);
      add(fn.description);
      if (fn.parameters ?? fn.input_schema) add(JSON.stringify(fn.parameters ?? fn.input_schema));
    }
    if (body.response_format) add(JSON.stringify(body.response_format));
  } catch {
    return protocolError("Invalid token-count content");
  }
  return Response.json({ input_tokens: encoder.encode(parts.join("\n")).length, estimated: true });
}
