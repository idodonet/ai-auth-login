import { executeResponses } from "./responses.js";
import { requestBody, translatedHeaders } from "./openai.js";
import { parseSSE, encodeSSE } from "./sse.js";
import { checkOptions, imageSource, unsupported, streamResponse } from "./anthropic.js";
import type { Wire, SendNative } from "./anthropic.js";

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
    "top_k",
    "stop",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "response_format",
    "reasoning_effort",
    "n",
    "modalities",
    "generationConfig",
  ]);
  const result: Wire = {
    model: body.model,
    stream: !!body.stream,
    contents: [],
    generationConfig: { ...body.generationConfig },
  };
  const system: Wire[] = [];
  const callNames = new Map<string, string>();
  for (const message of body.messages ?? []) {
    if (message.role === "system" || message.role === "developer") {
      if (typeof message.content !== "string") {
        throw new Error("System instructions must be text");
      }
      system.push({ text: message.content });
      continue;
    }
    const parts: Wire[] = [];
    if (message.role === "tool") {
      const name = callNames.get(message.tool_call_id);
      if (!name) {
        throw new Error("Tool response has no matching function call");
      }
      let response: unknown;
      try {
        response = JSON.parse(message.content);
      } catch {
        response = { result: message.content };
      }
      parts.push({
        functionResponse: {
          name,
          response:
            typeof response === "object" && response !== null && !Array.isArray(response)
              ? response
              : { result: response },
        },
      });
    } else if (typeof message.content === "string") {
      if (message.content) {
        parts.push({ text: message.content });
      }
    } else {
      for (const part of message.content ?? []) {
        if (part.type === "text") {
          parts.push({ text: part.text });
        } else if (part.type === "image_url") {
          const source = imageSource(part.image_url.url);
          parts.push(
            source.type === "base64"
              ? { inlineData: { mimeType: source.media_type, data: source.data } }
              : { fileData: { fileUri: source.url } },
          );
        } else if (part.type === "input_audio") {
          const audio = part.input_audio;
          if (!audio?.data || !audio.format) {
            throw new Error("Audio requires data and format");
          }
          const format = audio.format === "mp3" ? "mpeg" : audio.format;
          parts.push({ inlineData: { mimeType: `audio/${format}`, data: audio.data } });
        } else if (part.type === "file") {
          const file = part.file ?? {};
          if (!file.file_data && !file.file_url) {
            throw new Error("Gemini files require file_data or file_url; file_id is unsupported");
          }
          const source = imageSource(file.file_data ?? file.file_url);
          const types: Record<string, string> = {
            pdf: "application/pdf",
            txt: "text/plain",
            csv: "text/csv",
            json: "application/json",
            md: "text/markdown",
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            webp: "image/webp",
            mp4: "video/mp4",
            mp3: "audio/mpeg",
            wav: "audio/wav",
          };
          const filename = file.filename ?? (file.file_url ? new URL(file.file_url).pathname : "");
          const mimeType =
            source.type === "base64"
              ? source.media_type
              : (file.mime_type ?? types[String(filename).split(".").at(-1)!.toLowerCase()]);
          if (!mimeType) {
            throw new Error("Gemini file_data requires MIME data URL or recognized filename");
          }
          parts.push(
            file.file_url && source.type !== "base64"
              ? { fileData: { mimeType, fileUri: file.file_url } }
              : {
                  inlineData: {
                    mimeType,
                    data: source.type === "base64" ? source.data : file.file_data,
                  },
                },
          );
        } else if (part.type === "video_url") {
          const source = imageSource(part.video_url?.url ?? "");
          if (source.type !== "base64" || !source.media_type.startsWith("video/")) {
            throw new Error("Gemini video requires inline video data URL");
          }
          parts.push({ inlineData: { mimeType: source.media_type, data: source.data } });
        } else {
          throw new Error(`Unsupported content type: ${part.type}`);
        }
      }
    }
    for (const call of message.tool_calls ?? []) {
      callNames.set(call.id, call.function.name);
      parts.push({
        functionCall: { name: call.function.name, args: JSON.parse(call.function.arguments) },
        ...(call.thought_signature ? { thoughtSignature: call.thought_signature } : {}),
      });
    }
    if (message.reasoning_blocks) {
      for (const part of message.reasoning_blocks) {
        if (part.thought !== true || typeof part.text !== "string") {
          throw new Error("Invalid Gemini reasoning block");
        }
      }
      parts.unshift(...message.reasoning_blocks);
    } else if (message.reasoning_content) {
      parts.unshift({
        thought: true,
        text: message.reasoning_content,
        ...(message.reasoning_signature ? { thoughtSignature: message.reasoning_signature } : {}),
      });
    }
    result.contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  if (system.length) {
    result.systemInstruction = { parts: system };
  }
  const config = result.generationConfig;
  for (const [from, to] of [
    ["temperature", "temperature"],
    ["top_p", "topP"],
    ["top_k", "topK"],
    ["n", "candidateCount"],
  ]) {
    if (body[from!] !== undefined) {
      config[to!] = body[from!];
    }
  }
  if (body.max_tokens !== undefined || body.max_completion_tokens !== undefined) {
    config.maxOutputTokens = body.max_completion_tokens ?? body.max_tokens;
  }
  if (body.stop !== undefined) {
    config.stopSequences = typeof body.stop === "string" ? [body.stop] : body.stop;
  }
  if (body.modalities) {
    if (body.modalities.some((m: string) => !["text", "image"].includes(m))) {
      throw new Error("Unsupported Gemini output modality");
    }
    config.responseModalities = body.modalities.map((m: string) => m.toUpperCase());
  }
  if (body.reasoning_effort) {
    const effort = body.reasoning_effort;
    if (effort === "auto") {
      config.thinkingConfig = { thinkingBudget: -1, includeThoughts: true };
    } else if (effort === "none") {
      config.thinkingConfig = { thinkingBudget: 0 };
    } else if (/gemini-2\.5/.test(body.model)) {
      const budgets: Record<string, number> = {
        minimal: 512,
        low: 1024,
        medium: 8192,
        high: 24576,
        xhigh: 32768,
        max: 32768,
      };
      if (budgets[effort] === undefined) {
        throw new Error("Unsupported Gemini reasoning effort");
      }
      config.thinkingConfig = { thinkingBudget: budgets[effort], includeThoughts: true };
    } else {
      config.thinkingConfig = { thinkingLevel: effort, includeThoughts: true };
    }
  }
  if (body.response_format && body.response_format.type !== "text") {
    config.responseMimeType = "application/json";
    if (body.response_format.type === "json_schema") {
      config.responseJsonSchema = body.response_format.json_schema.schema;
    } else if (body.response_format.type !== "json_object") {
      throw new Error("Unsupported response format");
    }
  }
  if (body.tools?.length) {
    result.tools = [
      {
        functionDeclarations: body.tools.map((t: Wire) => {
          if (t.type !== "function") {
            throw new Error(`Unsupported tool: ${t.type}`);
          }
          return {
            name: t.function.name,
            description: t.function.description,
            parametersJsonSchema: t.function.parameters ?? { type: "object", properties: {} },
          };
        }),
      },
    ];
  }
  if (body.parallel_tool_calls === false) {
    throw new Error("Gemini cannot guarantee parallel_tool_calls:false");
  }
  if (body.tool_choice !== undefined) {
    result.toolConfig = {
      functionCallingConfig:
        typeof body.tool_choice === "string"
          ? {
              mode:
                body.tool_choice === "none"
                  ? "NONE"
                  : body.tool_choice === "required"
                    ? "ANY"
                    : body.tools?.some((t: Wire) => t.function?.strict)
                      ? "VALIDATED"
                      : "AUTO",
            }
          : { mode: "ANY", allowedFunctionNames: [body.tool_choice.function.name] },
    };
  }
  if (body.tool_choice === undefined && body.tools?.some((t: Wire) => t.function?.strict)) {
    result.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }
  return result;
}
function usage(value: Wire): Wire {
  const prompt = value.promptTokenCount ?? 0;
  const output = (value.candidatesTokenCount ?? 0) + (value.thoughtsTokenCount ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: value.totalTokenCount ?? prompt + output,
    prompt_tokens_details: { cached_tokens: value.cachedContentTokenCount ?? 0 },
    completion_tokens_details: { reasoning_tokens: value.thoughtsTokenCount ?? 0 },
  };
}
function finish(reason: string, tools: boolean): string {
  return reason === "MAX_TOKENS"
    ? "length"
    : ["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST"].includes(reason)
      ? "content_filter"
      : tools
        ? "tool_calls"
        : "stop";
}
function message(parts: Wire[]): Wire {
  const text = parts
    .filter((p) => p.text !== undefined && !p.thought)
    .map((p) => p.text)
    .join("");
  const reasoningBlocks = parts.filter((p) => p.thought);
  const reasoning = parts
    .filter((p) => p.thought)
    .map((p) => p.text ?? "")
    .join("");
  const calls = parts
    .filter((p) => p.functionCall)
    .map((p) => ({
      id: p.functionCall.id ?? "call_" + crypto.randomUUID(),
      type: "function",
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
      ...(p.thoughtSignature ? { thought_signature: p.thoughtSignature } : {}),
    }));
  const images = parts
    .filter((p) => p.inlineData)
    .map((p) => ({
      type: "image_url",
      image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` },
    }));
  return {
    role: "assistant",
    content: text || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(reasoningBlocks.length
      ? {
          reasoning_blocks: reasoningBlocks,
          ...(reasoningBlocks.length === 1 && reasoningBlocks[0].thoughtSignature
            ? { reasoning_signature: reasoningBlocks[0].thoughtSignature }
            : {}),
        }
      : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(images.length ? { images } : {}),
  };
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
    let envelope: Wire;
    try {
      envelope = await response.json();
    } catch {
      return Response.json({ error: { message: "Gemini returned invalid JSON" } }, { status: 502 });
    }
    const value = envelope?.response ?? envelope;
    if (
      !value ||
      typeof value !== "object" ||
      (!Array.isArray(value.candidates) && !value.error && !value.promptFeedback?.blockReason)
    ) {
      return Response.json(
        { error: { message: "Gemini returned an invalid response" } },
        { status: 502 },
      );
    }
    if (value.error) {
      return Response.json({ error: value.error }, { status: 502 });
    }
    const candidates = value.candidates ?? [];
    if (
      !candidates.every((candidate: unknown) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
        const content = (candidate as Wire).content;
        return (
          content === undefined ||
          (content !== null &&
            typeof content === "object" &&
            !Array.isArray(content) &&
            (content.parts === undefined ||
              (Array.isArray(content.parts) &&
                content.parts.every(
                  (part: unknown) =>
                    part !== null && typeof part === "object" && !Array.isArray(part),
                ))))
        );
      })
    )
      return Response.json(
        { error: { message: "Gemini returned invalid candidates" } },
        { status: 502 },
      );
    if (!candidates.length && value.promptFeedback?.blockReason) {
      return Response.json(
        {
          error: {
            message: `Gemini blocked prompt: ${value.promptFeedback.blockReason}`,
            code: "content_filter",
          },
        },
        { status: 400 },
      );
    }
    return Response.json(
      {
        id: value.responseId ?? "chatcmpl-" + crypto.randomUUID(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: value.modelVersion ?? body.model,
        choices: candidates.map((candidate: Wire, index: number) => {
          const msg = message(candidate.content?.parts ?? []);
          return {
            index: candidate.index ?? index,
            message: msg,
            finish_reason: finish(candidate.finishReason, !!msg.tool_calls),
          };
        }),
        usage: usage(value.usageMetadata ?? {}),
      },
      { status: response.status, headers: translatedHeaders(response) },
    );
  }
  if (!response.body) {
    throw new Error("Upstream returned an empty stream");
  }
  async function* events(): AsyncGenerator<Uint8Array> {
    let id = "chatcmpl-" + crypto.randomUUID();
    let toolIndex = 0;
    const hasTools = new Set<number>();
    const announced = new Set<number>();
    const finished = new Set<number>();
    for await (const event of parseSSE(response.body!, signal)) {
      if (!event.data || event.data === "[DONE]") {
        continue;
      }
      const envelope = JSON.parse(event.data) as Wire;
      const value = envelope.response ?? envelope;
      id = value.responseId ?? id;
      if (value.error) {
        yield encodeSSE(undefined, { error: value.error });
        return;
      }
      if (!value.candidates?.length && value.promptFeedback?.blockReason) {
        yield encodeSSE(undefined, {
          error: {
            message: `Gemini blocked prompt: ${value.promptFeedback.blockReason}`,
            code: "content_filter",
          },
        });
        return;
      }
      const choices: Wire[] = [];
      for (const candidate of value.candidates ?? []) {
        const index = candidate.index ?? 0;
        const delta: Wire = {};
        if (candidate.finishReason) finished.add(index);
        if (!announced.has(index)) {
          delta.role = "assistant";
          announced.add(index);
        }
        const msg = message(candidate.content?.parts ?? []);
        if (msg.content !== null) {
          delta.content = msg.content;
        }
        if (msg.reasoning_content) {
          delta.reasoning_content = msg.reasoning_content;
        }
        if (msg.reasoning_signature) {
          delta.reasoning_signature = msg.reasoning_signature;
        }
        if (msg.reasoning_blocks) {
          delta.reasoning_blocks = msg.reasoning_blocks;
        }
        if (msg.images) {
          delta.images = msg.images;
        }
        if (msg.tool_calls) {
          hasTools.add(index);
          delta.tool_calls = msg.tool_calls.map((call: Wire) => ({ index: toolIndex++, ...call }));
        }
        choices.push({
          index,
          delta,
          finish_reason: candidate.finishReason
            ? finish(candidate.finishReason, hasTools.has(index))
            : null,
        });
      }
      yield encodeSSE(undefined, {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: value.modelVersion ?? body.model,
        choices,
        ...(body.stream_options?.include_usage && value.usageMetadata
          ? { usage: usage(value.usageMetadata) }
          : {}),
      });
    }
    if (!announced.size || [...announced].some((index) => !finished.has(index))) {
      throw new Error("Gemini stream ended before completion");
    }
    yield encodeSSE(undefined, "[DONE]");
  }
  return streamResponse(events(), response, () => cancellation.abort());
}
export async function executeGemini(
  request: Request,
  sendNative: SendNative,
  allowCompact = false,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST") return unsupported("Unsupported Gemini method", 405);
  const native =
    /^\/(?:v1|v1beta)\/models\/([^/]+):(generateContent|streamGenerateContent|countTokens)$/.exec(
      path,
    );
  if (path === "/v1/responses" || (allowCompact && path === "/v1/responses/compact")) {
    return executeResponses(
      request,
      (body, signal) => convert(body, sendNative, signal),
      allowCompact,
    );
  }
  if (
    !native &&
    ![
      "/v1/chat/completions",
      "/v1/chat/completions/count_tokens",
      "/v1/messages/count_tokens",
    ].includes(path)
  )
    return unsupported("Unsupported Gemini endpoint", 404);
  const body = await requestBody(request);
  if (body instanceof Response) return body;
  if (native) {
    return sendNative(
      {
        ...body,
        model: decodeURIComponent(native[1]!),
        stream: native[2] === "streamGenerateContent",
      },
      request.signal,
      native[2] === "countTokens" ? "count" : undefined,
    );
  }
  if (path.endsWith("/count_tokens")) {
    let translated: Wire;
    try {
      translated = nativeBody(body);
    } catch (error) {
      return unsupported(error instanceof Error ? error.message : "Invalid count request");
    }
    delete translated.stream;
    delete translated.generationConfig;
    const response = await sendNative(translated, request.signal, "count");
    if (!response.ok) return response;
    try {
      const value = (await response.json()) as Wire;
      const tokens = (value.response ?? value).totalTokens;
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("Invalid count");
      return Response.json(
        { input_tokens: tokens, estimated: false },
        { headers: translatedHeaders(response) },
      );
    } catch {
      return unsupported("Invalid upstream token count", 502);
    }
  }
  return convert(body, sendNative, request.signal);
}

function interactionsBody(body: Wire): Wire {
  // Reuse validation and tool/image parsing, then translate the resulting wire values.
  if (body.generationConfig) {
    throw new Error("Interactions requires OpenAI generation options instead of generationConfig");
  }
  if (body.tools?.some((tool: Wire) => tool.function?.strict)) {
    throw new Error("Interactions cannot enforce strict function schemas");
  }
  const gemini = nativeBody(body);
  const result: Wire = { model: body.model, stream: !!body.stream, input: [] };
  if (gemini.systemInstruction) {
    result.system_instruction = gemini.systemInstruction.parts.map((p: Wire) => p.text).join("\n");
  }
  const config: Wire = {};
  for (const [from, to] of [
    ["temperature", "temperature"],
    ["topP", "top_p"],
    ["topK", "top_k"],
    ["maxOutputTokens", "max_output_tokens"],
    ["candidateCount", "candidate_count"],
    ["stopSequences", "stop_sequences"],
  ]) {
    if (gemini.generationConfig[from!] !== undefined) {
      config[to!] = gemini.generationConfig[from!];
    }
  }
  if (body.reasoning_effort) {
    config.thinking_level = body.reasoning_effort;
  }
  if (body.tool_choice) {
    config.tool_choice =
      typeof body.tool_choice === "string"
        ? body.tool_choice
        : { type: "function", name: body.tool_choice.function.name };
  }
  if (Object.keys(config).length) {
    result.generation_config = config;
  }
  if (body.response_format) {
    result.response_format = body.response_format;
  }
  if (body.modalities) {
    result.response_modalities = body.modalities;
  }
  if (body.tools) {
    result.tools = body.tools.map((t: Wire) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }
  for (const msg of body.messages ?? []) {
    if (["system", "developer"].includes(msg.role)) {
      continue;
    }
    if (msg.role === "tool") {
      result.input.push({
        type: "function_result",
        call_id: msg.tool_call_id,
        result: msg.content,
      });
      continue;
    }
    if (
      msg.reasoning_blocks ||
      msg.reasoning_signature ||
      msg.tool_calls?.some((call: Wire) => call.thought_signature)
    ) {
      throw new Error("Interactions cannot replay GenerateContent native signatures");
    }
    if (msg.reasoning_content) {
      result.input.push({
        type: "thought",
        content: [{ type: "text", text: msg.reasoning_content }],
      });
    }
    const content: Wire[] = [];
    if (typeof msg.content === "string") {
      content.push({ type: "text", text: msg.content });
    } else {
      for (const p of msg.content ?? []) {
        if (p.type === "text") {
          content.push({ type: "text", text: p.text });
        } else if (p.type === "image_url") {
          const source = imageSource(p.image_url.url);
          content.push(
            source.type === "base64"
              ? { type: "image", mime_type: source.media_type, data: source.data }
              : { type: "image", uri: source.url },
          );
        } else if (p.type === "input_audio") {
          content.push({
            type: "audio",
            mime_type: `audio/${p.input_audio.format === "mp3" ? "mpeg" : p.input_audio.format}`,
            data: p.input_audio.data,
          });
        } else if (p.type === "video_url") {
          const source = imageSource(p.video_url.url);
          content.push({ type: "video", mime_type: source.media_type, data: source.data });
        } else if (p.type === "file") {
          const source = imageSource(p.file.file_data);
          if (source.type !== "base64") {
            throw new Error("Interactions files require MIME data URL");
          }
          content.push({ type: "document", mime_type: source.media_type, data: source.data });
        } else {
          throw new Error(`Unsupported Interactions content type: ${p.type}`);
        }
      }
    }
    if (content.length) {
      result.input.push({
        type: msg.role === "assistant" ? "model_output" : "user_input",
        content,
      });
    }
    for (const call of msg.tool_calls ?? []) {
      result.input.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments),
      });
    }
  }
  return result;
}
function interactionUsage(value: Wire): Wire {
  const input = value.total_input_tokens ?? value.input_tokens ?? 0;
  const output = value.total_output_tokens ?? value.output_tokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: value.total_tokens ?? input + output,
    prompt_tokens_details: { cached_tokens: value.total_cached_tokens ?? value.cached_tokens ?? 0 },
    completion_tokens_details: {
      reasoning_tokens: value.total_thought_tokens ?? value.reasoning_tokens ?? 0,
    },
  };
}
async function convertInteractions(
  body: Wire,
  sendNative: SendNative,
  signal: AbortSignal,
): Promise<Response> {
  let native: Wire;
  try {
    native = interactionsBody(body);
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
    let root: Wire;
    try {
      root = await response.json();
    } catch {
      return Response.json(
        { error: { message: "Interactions returned invalid JSON" } },
        { status: 502 },
      );
    }
    const value = root?.interaction ?? root;
    const output = value?.steps ?? value?.outputs ?? value?.output;
    if (!Array.isArray(output)) {
      return Response.json(
        { error: { message: "Interactions returned an invalid response" } },
        { status: 502 },
      );
    }
    if (
      !output.every((step: unknown) => {
        if (!step || typeof step !== "object" || Array.isArray(step)) return false;
        const content = (step as Wire).content;
        return (
          content === undefined ||
          typeof content === "string" ||
          (Array.isArray(content) &&
            content.every(
              (part: unknown) => part !== null && typeof part === "object" && !Array.isArray(part),
            ))
        );
      })
    )
      return Response.json(
        { error: { message: "Interactions returned invalid steps" } },
        { status: 502 },
      );
    const tools: Wire[] = [];
    let text = "";
    let reasoning = "";
    for (const step of output) {
      if (step.type === "function_call") {
        tools.push({
          id: step.call_id ?? step.id,
          type: "function",
          function: {
            name: step.name,
            arguments:
              typeof step.arguments === "string"
                ? step.arguments
                : JSON.stringify(step.arguments ?? {}),
          },
        });
      } else {
        const parts =
          typeof step.content === "string" ? [{ text: step.content }] : (step.content ?? []);
        const joined = parts.map((p: Wire) => p.text ?? "").join("");
        if (step.type === "thought") {
          reasoning += joined;
        } else {
          text += joined;
        }
      }
    }
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
              content: text || null,
              ...(tools.length ? { tool_calls: tools } : {}),
              ...(reasoning ? { reasoning_content: reasoning } : {}),
            },
            finish_reason: tools.length ? "tool_calls" : "stop",
          },
        ],
        usage: interactionUsage(value.usage ?? {}),
      },
      { status: response.status, headers: translatedHeaders(response) },
    );
  }
  if (!response.body) {
    throw new Error("Upstream returned an empty stream");
  }
  async function* events(): AsyncGenerator<Uint8Array> {
    let id = "chatcmpl-" + crypto.randomUUID();
    const indexes = new Map<number, number>();
    let nextTool = 0;
    let completed = false;
    const chunk = (delta: Wire, reason: string | null = null, extra: Wire = {}) =>
      encodeSSE(undefined, {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: reason }],
        ...extra,
      });
    for await (const event of parseSSE(response.body!, signal)) {
      if (!event.data || event.data === "[DONE]") {
        continue;
      }
      const value = JSON.parse(event.data) as Wire;
      const type = value.event_type ?? event.event;
      if (type === "interaction.created") {
        id = value.interaction?.id ?? id;
        yield chunk({ role: "assistant", content: "" });
      }
      if (type === "step.start" && value.step?.type === "function_call") {
        const index = nextTool++;
        indexes.set(value.index, index);
        const call = value.step;
        yield chunk({
          tool_calls: [
            {
              index,
              id: call.call_id ?? call.id,
              type: "function",
              function: {
                name: call.name,
                arguments:
                  call.arguments && Object.keys(call.arguments).length
                    ? JSON.stringify(call.arguments)
                    : "",
              },
            },
          ],
        });
      }
      if (type === "step.delta") {
        const delta = value.delta ?? {};
        if (delta.type === "arguments_delta") {
          yield chunk({
            tool_calls: [
              { index: indexes.get(value.index), function: { arguments: delta.arguments } },
            ],
          });
        } else if (delta.type === "thought_summary") {
          yield chunk({ reasoning_content: delta.content?.text ?? delta.text ?? "" });
        } else if (delta.text !== undefined) {
          yield chunk({ content: delta.text });
        }
      }
      if (type === "interaction.completed" || type === "finish") {
        completed = true;
        yield chunk(
          {},
          indexes.size ? "tool_calls" : "stop",
          body.stream_options?.include_usage
            ? { usage: interactionUsage(value.interaction?.usage ?? value.usage ?? {}) }
            : {},
        );
      }
      if (type === "interaction.failed" || type === "error") {
        yield encodeSSE(undefined, { error: value.error ?? { message: "Interaction failed" } });
        return;
      }
    }
    if (!completed) throw new Error("Interactions stream ended before completion");
    yield encodeSSE(undefined, "[DONE]");
  }
  return streamResponse(events(), response, () => cancellation.abort());
}
export async function executeInteractions(
  request: Request,
  sendNative: SendNative,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST") return unsupported("Unsupported Interactions method", 405);
  if (path === "/v1/responses")
    return executeResponses(request, (body, signal) =>
      convertInteractions(body, sendNative, signal),
    );
  if (!["/v1beta/interactions", "/v1/interactions", "/v1/chat/completions"].includes(path))
    return unsupported("Unsupported Interactions endpoint", 404);
  const body = await requestBody(request);
  if (body instanceof Response) return body;
  if (path !== "/v1/chat/completions") return sendNative(body, request.signal);
  return convertInteractions(body, sendNative, request.signal);
}

/** The Antigravity Claude/image backend streams even for a non-stream caller. */
export async function collectGeminiStream(
  response: Response,
  signal: AbortSignal,
): Promise<Response> {
  if (!response.body) throw new Error("Gemini stream has no body");
  const candidates = new Map<number, Wire>();
  let result: Wire = {},
    envelope: Wire = {},
    wrapped = false;
  for await (const event of parseSSE(response.body, signal)) {
    if (event.data === "[DONE]") continue;
    const value = JSON.parse(event.data) as Wire;
    if (value.error)
      return Response.json(value, { status: 502, headers: translatedHeaders(response) });
    wrapped ||= !!value.response;
    envelope = { ...envelope, ...value };
    const native = value.response ?? value;
    result = { ...result, ...native };
    for (const candidate of native.candidates ?? []) {
      const index = candidate.index ?? 0;
      const prior = candidates.get(index);
      const parts = [...(prior?.content?.parts ?? [])];
      for (const part of candidate.content?.parts ?? []) {
        const last = parts.at(-1);
        if (
          typeof part.text === "string" &&
          last &&
          typeof last.text === "string" &&
          !!part.thought === !!last.thought &&
          !last.thoughtSignature
        ) {
          const text = last.text + part.text;
          Object.assign(last, part, { text });
        } else parts.push({ ...part });
      }
      candidates.set(index, {
        ...prior,
        ...candidate,
        content: { ...prior?.content, ...candidate.content, parts },
      });
    }
  }
  if (!candidates.size || [...candidates.values()].some((candidate) => !candidate.finishReason)) {
    throw new Error("Gemini stream ended before completion");
  }
  result.candidates = [...candidates.values()];
  return Response.json(wrapped ? { ...envelope, response: result } : result, {
    headers: translatedHeaders(response),
  });
}

export function geminiCountBody(model: string, payload: Wire): Wire {
  if (
    payload.generateContentRequest ||
    !["systemInstruction", "tools", "toolConfig"].some((key) => key in payload)
  )
    return payload;
  return { generateContentRequest: { ...payload, model: `models/${model}` } };
}
