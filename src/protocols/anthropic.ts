import { executeResponses } from "./responses.js";
import { requestBody, protocolError, rejectFields, translatedHeaders } from "./openai.js";
import { parseSSE, encodeSSE, streamSSE } from "./sse.js";

// JSON wire payloads vary by upstream protocol.
export type Wire = Record<string, any>;
export type SendNative = (
  body: Record<string, unknown>,
  signal: AbortSignal,
  action?: "count",
) => Promise<Response>;
export const unsupported = protocolError;
export const checkOptions = rejectFields;
export function imageSource(url: string): Wire {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
  return match ? { type: "base64", media_type: match[1], data: match[2] } : { type: "url", url };
}
export const streamResponse = streamSSE;
const adaptiveModels = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
];
function nativeBody(body: Wire): Wire {
  checkOptions(body, [
    "model",
    "messages",
    "stream",
    "stream_options",
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "stop",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "response_format",
    "reasoning_effort",
    "user",
    "n",
  ]);
  if (body.n !== undefined && body.n !== 1) {
    throw new Error("Anthropic supports one completion per request");
  }
  const result: Wire = {
    model: body.model,
    max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 32000,
    stream: !!body.stream,
    messages: [],
  };
  const system: Wire[] = [];
  for (const message of body.messages ?? []) {
    if (message.role === "system" || message.role === "developer") {
      if (typeof message.content !== "string") {
        throw new Error("System instructions must be text");
      }
      system.push({ type: "text", text: message.content });
      continue;
    }
    const content: Wire[] = [];
    if (message.role === "tool") {
      content.push({
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: typeof message.content === "string" ? message.content : message.content,
      });
    } else if (typeof message.content === "string") {
      if (message.content) {
        content.push({ type: "text", text: message.content });
      }
    } else {
      for (const part of message.content ?? []) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "image_url") {
          content.push({ type: "image", source: imageSource(part.image_url.url) });
        } else if (part.type === "file") {
          if (!part.file?.file_data) {
            throw new Error(
              "Anthropic documents require inline file_data; file URLs and IDs are unsupported",
            );
          }
          let source = imageSource(part.file.file_data);
          if (source.type !== "base64") {
            if (
              !String(part.file.filename ?? "")
                .toLowerCase()
                .endsWith(".pdf")
            ) {
              throw new Error(
                "Anthropic raw document data requires a PDF filename or MIME data URL",
              );
            }
            source = { type: "base64", media_type: "application/pdf", data: part.file.file_data };
          }
          content.push({
            type: "document",
            source,
            ...(part.file.filename ? { title: part.file.filename } : {}),
          });
        } else {
          throw new Error(`Unsupported content type: ${part.type}`);
        }
      }
    }
    for (const call of message.tool_calls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments),
      });
    }
    if (message.reasoning_blocks) {
      for (const block of message.reasoning_blocks) {
        if (
          block.type === "thinking" &&
          typeof block.thinking === "string" &&
          typeof block.signature === "string" &&
          block.signature
        ) {
          continue;
        }
        if (block.type === "redacted_thinking" && typeof block.data === "string" && block.data) {
          continue;
        }
        throw new Error("Anthropic reasoning replay requires signed thinking blocks");
      }
      content.unshift(...message.reasoning_blocks);
    } else if (message.reasoning_content) {
      if (!message.reasoning_signature) {
        throw new Error("Unsigned Anthropic reasoning cannot be replayed");
      }
      content.unshift({
        type: "thinking",
        thinking: message.reasoning_content,
        signature: message.reasoning_signature,
      });
    }
    result.messages.push({ role: message.role === "assistant" ? "assistant" : "user", content });
  }
  if (system.length) {
    result.system = system;
  }
  for (const key of ["temperature", "top_p"]) {
    if (body[key] !== undefined) {
      result[key] = body[key];
    }
  }
  if (body.stop !== undefined) {
    result.stop_sequences = typeof body.stop === "string" ? [body.stop] : body.stop;
  }
  if (body.user) {
    result.metadata = { user_id: body.user };
  }
  if (body.tools) {
    result.tools = body.tools.map((tool: Wire) => {
      if (tool.type !== "function") {
        throw new Error(`Unsupported tool: ${tool.type}`);
      }
      return {
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters ?? { type: "object", properties: {} },
        ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
      };
    });
  }
  if (body.tool_choice !== undefined) {
    result.tool_choice =
      typeof body.tool_choice === "string"
        ? { type: body.tool_choice === "required" ? "any" : body.tool_choice }
        : { type: "tool", name: body.tool_choice.function.name };
  }
  if (body.parallel_tool_calls !== undefined) {
    result.tool_choice = {
      ...(result.tool_choice ?? { type: "auto" }),
      disable_parallel_tool_use: !body.parallel_tool_calls,
    };
  }
  if (body.response_format && body.response_format.type !== "text") {
    if (body.response_format.type === "json_object") {
      // ponytail: prompt-guided JSON matches CLIProxyAPI; use json_schema for native constrained output.
      result.system = [
        ...system,
        {
          type: "text",
          text: "Return your entire response as a valid JSON object without explanations, Markdown fences, or text outside the object.",
        },
      ];
    } else if (body.response_format.type === "json_schema") {
      result.output_config = {
        format: { type: "json_schema", schema: body.response_format.json_schema.schema },
      };
    } else {
      throw new Error("Unsupported Anthropic response format");
    }
  }
  if (body.reasoning_effort) {
    const effort = body.reasoning_effort;
    if (!["none", "auto", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort))
      throw new Error("Unsupported Anthropic reasoning effort");
    if (effort === "none") {
      result.thinking = { type: "disabled" };
    } else if (adaptiveModels.includes(body.model)) {
      result.thinking = { type: "adaptive" };
      if (effort !== "auto") {
        result.output_config = {
          ...result.output_config,
          effort:
            effort === "minimal"
              ? "low"
              : effort === "xhigh" && /4[.-]6/.test(body.model)
                ? "high"
                : effort,
        };
      }
    } else {
      const budgets: Record<string, number> = {
        auto: 8192,
        minimal: 1024,
        low: 1024,
        medium: 8192,
        high: 24576,
        xhigh: 32768,
        max: 128000,
      };
      if (budgets[effort] === undefined) {
        throw new Error("Unsupported Anthropic reasoning effort");
      }
      if (result.max_tokens <= 1024) {
        throw new Error("Anthropic thinking requires max tokens greater than 1024");
      }
      result.thinking = {
        type: "enabled",
        budget_tokens: Math.min(budgets[effort]!, result.max_tokens - 1),
      };
    }
  }
  return result;
}
function usage(value: Wire): Wire {
  const input =
    (value.input_tokens ?? 0) +
    (value.cache_read_input_tokens ?? 0) +
    (value.cache_creation_input_tokens ?? 0);
  return {
    prompt_tokens: input,
    completion_tokens: value.output_tokens ?? 0,
    total_tokens: input + (value.output_tokens ?? 0),
    prompt_tokens_details: { cached_tokens: value.cache_read_input_tokens ?? 0 },
  };
}
function finish(reason: string): string {
  return reason === "tool_use" ? "tool_calls" : reason === "max_tokens" ? "length" : "stop";
}
async function convert(body: Wire, sendNative: SendNative, signal: AbortSignal): Promise<Response> {
  let native: Wire;
  try {
    native = nativeBody(body);
  } catch (error) {
    return unsupported((error as Error).message);
  }
  const cancellation = new AbortController();
  signal = AbortSignal.any([signal, cancellation.signal]);
  const response = await sendNative(native, signal);
  if (!response.ok) {
    return response;
  }
  if (!body.stream) {
    let value: Wire;
    try {
      value = (await response.json()) as Wire;
      if (
        !value ||
        typeof value !== "object" ||
        !Array.isArray(value.content) ||
        typeof value.stop_reason !== "string" ||
        value.content.some(
          (block: Wire) =>
            !block ||
            typeof block !== "object" ||
            typeof block.type !== "string" ||
            (block.type === "text" && typeof block.text !== "string"),
        )
      ) {
        return unsupported("Invalid upstream Anthropic completion", 502);
      }
    } catch {
      return unsupported("Invalid upstream Anthropic completion", 502);
    }
    const blocks = value.content;
    const reasoningBlocks = blocks.filter(
      (b: Wire) => b.type === "thinking" || b.type === "redacted_thinking",
    );
    const tools = blocks
      .filter((b: Wire) => b.type === "tool_use")
      .map((b: Wire) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }));
    return Response.json(
      {
        id: value.id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: value.model ?? body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                blocks
                  .filter((b: Wire) => b.type === "text")
                  .map((b: Wire) => b.text)
                  .join("") || null,
              ...(tools.length ? { tool_calls: tools } : {}),
              ...(reasoningBlocks.length
                ? {
                    reasoning_blocks: reasoningBlocks,
                    ...(reasoningBlocks.length === 1 && reasoningBlocks[0].signature
                      ? { reasoning_signature: reasoningBlocks[0].signature }
                      : {}),
                  }
                : {}),
              ...(blocks.some((b: Wire) => b.type === "thinking")
                ? {
                    reasoning_content: blocks
                      .filter((b: Wire) => b.type === "thinking")
                      .map((b: Wire) => b.thinking)
                      .join(""),
                  }
                : {}),
            },
            finish_reason: finish(value.stop_reason),
          },
        ],
        usage: usage(value.usage ?? {}),
      },
      { status: response.status, headers: translatedHeaders(response) },
    );
  }
  if (!response.body) {
    throw new Error("Upstream returned an empty stream");
  }
  async function* events(): AsyncGenerator<Uint8Array> {
    let id = "chatcmpl-" + crypto.randomUUID();
    let model = body.model;
    let tokens: Wire = {};
    let toolIndex = 0;
    let finished = false;
    const indexes = new Map<number, number>();
    const thinking = new Map<number, Wire>();
    const chunk = (delta: Wire, reason: string | null = null, extra: Wire = {}) =>
      encodeSSE(undefined, {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: reason }],
        ...extra,
      });
    for await (const event of parseSSE(response.body!, signal)) {
      if (!event.data || event.data === "[DONE]") {
        continue;
      }
      const value = JSON.parse(event.data) as Wire;
      if (value.type === "error") {
        yield encodeSSE(undefined, { error: value.error });
        return;
      }
      if (value.type === "message_start") {
        id = value.message.id;
        model = value.message.model ?? model;
        tokens = value.message.usage ?? {};
        yield chunk({ role: "assistant", content: "" });
      }
      if (value.type === "content_block_start" && value.content_block.type === "tool_use") {
        const index = toolIndex++;
        indexes.set(value.index, index);
        yield chunk({
          tool_calls: [
            {
              index,
              id: value.content_block.id,
              type: "function",
              function: {
                name: value.content_block.name,
                arguments: Object.keys(value.content_block.input ?? {}).length
                  ? JSON.stringify(value.content_block.input)
                  : "",
              },
            },
          ],
        });
      }
      if (
        value.type === "content_block_start" &&
        ["thinking", "redacted_thinking"].includes(value.content_block.type)
      ) {
        thinking.set(value.index, { ...value.content_block });
      }
      if (value.type === "content_block_delta") {
        const delta = value.delta;
        if (delta.type === "text_delta") {
          yield chunk({ content: delta.text });
        }
        if (delta.type === "thinking_delta") {
          const block = thinking.get(value.index);
          if (block) {
            block.thinking = (block.thinking ?? "") + delta.thinking;
          }
          yield chunk({ reasoning_content: delta.thinking });
        }
        if (delta.type === "signature_delta") {
          const block = thinking.get(value.index);
          if (block) {
            block.signature = (block.signature ?? "") + delta.signature;
          }
          yield chunk({ reasoning_signature: delta.signature });
        }
        if (delta.type === "input_json_delta") {
          yield chunk({
            tool_calls: [
              { index: indexes.get(value.index), function: { arguments: delta.partial_json } },
            ],
          });
        }
      }
      if (value.type === "content_block_stop" && thinking.has(value.index)) {
        yield chunk({ reasoning_blocks: [thinking.get(value.index)] });
      }
      if (value.type === "message_delta") {
        tokens = { ...tokens, ...value.usage };
        if (!value.delta.stop_reason) {
          continue;
        }
        finished = true;
        yield chunk(
          {},
          finish(value.delta.stop_reason),
          body.stream_options?.include_usage ? { usage: usage(tokens) } : {},
        );
      }
    }
    if (!finished) {
      throw new Error("Upstream Anthropic stream ended before completion");
    }
    yield encodeSSE(undefined, "[DONE]");
  }
  return streamResponse(events(), response, () => cancellation.abort());
}
export async function executeAnthropic(
  request: Request,
  sendNative: SendNative,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST") return unsupported("Unsupported Anthropic method", 405);
  if (path === "/v1/responses" || path === "/v1/responses/compact") {
    return executeResponses(request, (body, signal) => convert(body, sendNative, signal), true);
  }
  if (
    ![
      "/v1/messages",
      "/v1/messages/count_tokens",
      "/v1/chat/completions/count_tokens",
      "/v1/chat/completions",
    ].includes(path)
  )
    return unsupported("Unsupported Anthropic endpoint", 404);
  const body = await requestBody(request);
  if (body instanceof Response) return body;
  if (path === "/v1/messages") return sendNative(body, request.signal);
  if (path === "/v1/messages/count_tokens") return sendNative(body, request.signal, "count");
  if (path === "/v1/chat/completions/count_tokens") {
    let native: Wire;
    try {
      const countInput = { ...body };
      for (const key of [
        "reasoning_effort",
        "max_tokens",
        "max_completion_tokens",
        "stream",
        "stream_options",
      ])
        delete countInput[key];
      native = nativeBody(countInput);
    } catch (error) {
      return unsupported(error instanceof Error ? error.message : "Invalid count request");
    }
    for (const key of [
      "max_tokens",
      "stream",
      "thinking",
      "output_config",
      "temperature",
      "top_p",
      "stop_sequences",
    ])
      delete native[key];
    return sendNative(native, request.signal, "count");
  }
  return convert(body, sendNative, request.signal);
}
