import { seal, unseal, reasoningPrefix, compactionPrefix } from "./capsules.js";
import { protocolError, rejectFields, translatedHeaders } from "./openai.js";
import type { JSONBody, NativeFetch } from "./openai.js";
import { encodeSSE, parseSSE, streamSSE } from "./sse.js";

const common = [
  "model",
  "stream",
  "temperature",
  "top_p",
  "parallel_tool_calls",
  "metadata",
  "store",
  "service_tier",
  "user",
];
function copy(body: JSONBody): JSONBody {
  return Object.fromEntries(common.filter((key) => key in body).map((key) => [key, body[key]]));
}
function chatContent(content: any): any {
  if (typeof content === "string" || content == null) {
    return content;
  }
  if (!Array.isArray(content)) {
    throw new Error("Message content must be text or an array");
  }
  return content.map((part) => {
    if (part.type === "input_text" || part.type === "output_text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "input_file") {
      if (part.file_id) {
        throw new Error("Translated files require file_data or file_url; file_id is unsupported");
      }
      if (!part.file_data && !part.file_url) {
        throw new Error("Input file requires file_data or file_url");
      }
      if (part.detail !== undefined || part.prompt_cache_breakpoint !== undefined) {
        throw new Error("Translated input files do not support detail or prompt_cache_breakpoint");
      }
      return {
        type: "file",
        file: {
          ...(part.file_data ? { file_data: part.file_data } : {}),
          ...(part.file_url ? { file_url: part.file_url } : {}),
          ...(part.filename ? { filename: part.filename } : {}),
        },
      };
    }
    if (part.type === "input_audio" && part.input_audio) {
      return { type: "input_audio", input_audio: part.input_audio };
    }
    if (part.type === "input_video" && part.video_url) {
      return {
        type: "video_url",
        video_url: typeof part.video_url === "string" ? { url: part.video_url } : part.video_url,
      };
    }
    if (part.type === "input_image" && part.image_url) {
      return {
        type: "image_url",
        image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) },
      };
    }
    throw new Error(`Unsupported Responses content: ${part.type}`);
  });
}
function responseContent(content: any, role: string): any {
  if (typeof content === "string") {
    return [{ type: role === "assistant" ? "output_text" : "input_text", text: content }];
  }
  if (content == null) {
    return [];
  }
  if (!Array.isArray(content)) {
    throw new Error("Message content must be text or an array");
  }
  return content.map((part) => {
    if (part.type === "text") {
      return { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
    }
    if (part.type === "file" && role !== "assistant") {
      if (part.file.file_id) {
        throw new Error("Translated files require file_data or file_url; file_id is unsupported");
      }
      return { type: "input_file", ...part.file };
    }
    if (part.type === "input_audio" && role !== "assistant") {
      return { type: "input_audio", input_audio: part.input_audio };
    }
    if (part.type === "video_url" && role !== "assistant") {
      return { type: "input_video", video_url: part.video_url.url };
    }
    if (part.type === "image_url" && role !== "assistant") {
      return {
        type: "input_image",
        image_url: part.image_url.url,
        ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
      };
    }
    throw new Error(`Unsupported Chat content: ${part.type}`);
  });
}
export function responsesToChat(body: JSONBody): JSONBody {
  rejectFields(body, [
    ...common,
    "input",
    "instructions",
    "max_output_tokens",
    "tools",
    "tool_choice",
    "text",
    "reasoning",
  ]);
  const result = copy(body),
    messages: JSONBody[] = [];
  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input =
    typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
  if (!Array.isArray(input)) {
    throw new Error("Responses input must be text or an array");
  }
  for (const item of input) {
    if (!item.type || item.type === "message") {
      const last = messages.at(-1);
      if (item.role === "assistant" && last?.role === "assistant" && last.content === null)
        last.content = chatContent(item.content);
      else messages.push({ role: item.role, content: chatContent(item.content) });
    } else if (item.type === "function_call") {
      const last = messages.at(-1);
      const call = {
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
        ...(item.thought_signature ? { thought_signature: item.thought_signature } : {}),
      };
      if (last?.role === "assistant") {
        (last.tool_calls ??= []).push(call);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [call] });
      }
    } else if (item.type === "reasoning") {
      if (!item.encrypted_content) continue; // Display summaries are not replayable native thinking.
      const carrier = unseal(reasoningPrefix, item.encrypted_content);
      if (!Array.isArray(carrier.reasoning_blocks))
        throw new Error("Invalid reasoning continuation");
      const last = messages.at(-1);
      if (last?.role === "assistant")
        (last.reasoning_blocks ??= []).push(...carrier.reasoning_blocks);
      else
        messages.push({
          role: "assistant",
          content: null,
          reasoning_blocks: carrier.reasoning_blocks,
        });
    } else if (item.type === "compaction") {
      const capsule = unseal(compactionPrefix, item.encrypted_content);
      if (typeof capsule.summary !== "string" || !capsule.summary.trim())
        throw new Error("Invalid compaction summary");
      messages.push({
        role: "developer",
        content: "Context summary from previous turns:\n" + capsule.summary,
      });
    } else if (item.type === "function_call_output") {
      if (typeof item.output !== "string") {
        throw new Error("Structured function output is unsupported");
      }
      messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
    } else {
      throw new Error(`Unsupported Responses input item: ${item.type}`);
    }
  }
  result.messages = messages;
  if (body.max_output_tokens !== undefined) {
    result.max_completion_tokens = body.max_output_tokens;
  }
  if (body.tools) {
    result.tools = body.tools.map((tool: JSONBody) => {
      if (tool.type !== "function") {
        throw new Error(`Unsupported translated tool: ${tool.type}`);
      }
      const { type, ...fn } = tool;
      return { type, function: fn };
    });
  }
  if (body.tool_choice) {
    if (typeof body.tool_choice !== "string" && body.tool_choice.type !== "function") {
      throw new Error("Unsupported translated tool choice");
    }
    result.tool_choice =
      typeof body.tool_choice === "string"
        ? body.tool_choice
        : { type: "function", function: { name: body.tool_choice.name } };
  }
  if (body.text) {
    rejectFields(body.text, ["format"]);
    const format = body.text.format;
    if (format) {
      result.response_format =
        format.type === "json_schema"
          ? {
              type: "json_schema",
              json_schema: Object.fromEntries(Object.entries(format).filter(([k]) => k !== "type")),
            }
          : format;
    }
  }
  if (body.reasoning) {
    rejectFields(body.reasoning, ["effort", "summary"]);
    if (body.reasoning.summary !== undefined && body.reasoning.summary !== "auto") {
      throw new Error("Translated reasoning supports summary=auto only");
    }
    if (body.reasoning.effort !== undefined) {
      result.reasoning_effort = body.reasoning.effort;
    }
  }
  if (body.stream) {
    result.stream_options = { include_usage: true };
  }
  return result;
}
export function chatToResponses(body: JSONBody): JSONBody {
  rejectFields(body, [
    ...common,
    "messages",
    "max_tokens",
    "max_completion_tokens",
    "tools",
    "tool_choice",
    "response_format",
    "reasoning_effort",
    "stream_options",
    "n",
  ]);
  if (body.n !== undefined && body.n !== 1) {
    throw new Error("Translated requests support n=1");
  }
  if (body.stream_options) {
    rejectFields(body.stream_options, ["include_usage"]);
  }
  if (!Array.isArray(body.messages)) {
    throw new Error("Chat messages must be an array");
  }
  const result = copy(body),
    input: JSONBody[] = [];
  for (const message of body.messages) {
    rejectFields(message, [
      "role",
      "content",
      "tool_calls",
      "tool_call_id",
      "reasoning_items",
      "reasoning_content",
      "reasoning_blocks",
      "reasoning_signature",
    ]);
    if (message.reasoning_items) input.push(...message.reasoning_items);
    else if (message.reasoning_blocks?.length)
      input.push({
        type: "reasoning",
        summary: [],
        encrypted_content: seal(reasoningPrefix, { reasoning_blocks: message.reasoning_blocks }),
      });
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content,
      });
    } else {
      if (message.content != null) {
        input.push({ role: message.role, content: responseContent(message.content, message.role) });
      }
      for (const call of message.tool_calls ?? []) {
        if (call.type !== "function") {
          throw new Error(`Unsupported Chat tool call: ${call.type}`);
        }
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
          ...(call.thought_signature ? { thought_signature: call.thought_signature } : {}),
        });
      }
    }
  }
  result.input = input;
  if (body.max_completion_tokens !== undefined || body.max_tokens !== undefined) {
    result.max_output_tokens = body.max_completion_tokens ?? body.max_tokens;
  }
  if (body.tools) {
    result.tools = body.tools.map((tool: JSONBody) => {
      if (tool.type !== "function") {
        throw new Error(`Unsupported translated tool: ${tool.type}`);
      }
      return { type: "function", ...tool.function };
    });
  }
  if (body.tool_choice) {
    if (typeof body.tool_choice !== "string" && body.tool_choice.type !== "function") {
      throw new Error("Unsupported translated tool choice");
    }
    result.tool_choice =
      typeof body.tool_choice === "string"
        ? body.tool_choice
        : { type: "function", name: body.tool_choice.function.name };
  }
  if (body.response_format) {
    result.text = {
      format:
        body.response_format.type === "json_schema"
          ? { type: "json_schema", ...body.response_format.json_schema }
          : body.response_format,
    };
  }
  if (body.reasoning_effort) {
    result.reasoning = { effort: body.reasoning_effort };
  }
  return result;
}
function responseUsage(usage: JSONBody | undefined): JSONBody | null {
  return usage
    ? {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
        input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
        output_tokens_details: {
          reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
        },
      }
    : null;
}
function chatUsage(usage: JSONBody | undefined): JSONBody | undefined {
  return usage
    ? {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
        prompt_tokens_details: usage.input_tokens_details,
        completion_tokens_details: usage.output_tokens_details,
      }
    : undefined;
}
function imageOutput(image: JSONBody): JSONBody {
  const url = image.image_url?.url;
  const match =
    typeof url === "string"
      ? /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(url)
      : null;
  if (!match) {
    throw new Error("Translated generated images require a base64 image data URL");
  }
  return {
    id: `ig_${crypto.randomUUID()}`,
    type: "image_generation_call",
    status: "completed",
    result: match[2],
    output_format: match[1],
  };
}
function imageDataURL(item: JSONBody): string {
  const header = atob(String(item.result).slice(0, 16));
  const format =
    item.output_format ??
    (header.startsWith("\x89PNG")
      ? "png"
      : header.startsWith("\xff\xd8\xff")
        ? "jpeg"
        : header.startsWith("GIF8")
          ? "gif"
          : header.startsWith("RIFF")
            ? "webp"
            : null);
  if (!format || !["png", "jpeg", "webp", "gif"].includes(format)) {
    throw new Error("Generated image format cannot be determined");
  }
  return `data:image/${format};base64,${item.result}`;
}
export function chatCompletionToResponse(chat: JSONBody, request: JSONBody): JSONBody {
  if (chat.error) {
    return chat;
  }
  const choice = chat.choices?.[0];
  if (!choice || chat.choices.length !== 1) {
    throw new Error("Expected one Chat completion choice");
  }
  const message = choice.message,
    output: JSONBody[] = [];
  if (message.reasoning_content || message.reasoning_blocks?.length) {
    output.push({
      id: `rs_${chat.id}`,
      type: "reasoning",
      status: "completed",
      summary: message.reasoning_content
        ? [{ type: "summary_text", text: message.reasoning_content }]
        : [],
      ...(message.reasoning_blocks?.length
        ? {
            encrypted_content: seal(reasoningPrefix, {
              reasoning_blocks: message.reasoning_blocks,
            }),
          }
        : {}),
    });
  }
  if (message.content != null || message.refusal) {
    output.push({
      id: `msg_${chat.id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: message.refusal
        ? [{ type: "refusal", refusal: message.refusal }]
        : [{ type: "output_text", text: message.content ?? "", annotations: [] }],
    });
  }
  for (const call of message.tool_calls ?? []) {
    output.push({
      id: `fc_${call.id}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      ...(call.thought_signature ? { thought_signature: call.thought_signature } : {}),
    });
  }
  for (const image of message.images ?? []) {
    output.push(imageOutput(image));
  }
  const incomplete = choice.finish_reason === "length" || choice.finish_reason === "content_filter";
  return {
    id: `resp_${chat.id}`,
    object: "response",
    created_at: chat.created ?? Math.floor(Date.now() / 1000),
    status: incomplete ? "incomplete" : "completed",
    error: null,
    incomplete_details: incomplete
      ? { reason: choice.finish_reason === "length" ? "max_output_tokens" : "content_filter" }
      : null,
    model: chat.model ?? request.model,
    output,
    usage: responseUsage(chat.usage),
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    tools: request.tools ?? [],
    tool_choice: request.tool_choice ?? "auto",
  };
}
export function responseToChatCompletion(response: JSONBody): JSONBody {
  if (response.error) {
    return { error: response.error };
  }
  let content = "",
    refusal = "",
    reasoning = "",
    calls: JSONBody[] = [],
    reasoningItems: JSONBody[] = [],
    images: JSONBody[] = [];
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") {
          content += part.text;
        } else if (part.type === "refusal") {
          refusal += part.refusal;
        } else {
          throw new Error(`Unsupported Responses output content: ${part.type}`);
        }
      }
    } else if (item.type === "function_call") {
      calls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
        ...(item.thought_signature ? { thought_signature: item.thought_signature } : {}),
      });
    } else if (item.type === "image_generation_call") {
      if (item.result) {
        images.push({ type: "image_url", image_url: { url: imageDataURL(item) } });
      }
    } else if (item.type === "reasoning") {
      if (item.encrypted_content) reasoningItems.push(item);
      for (const part of item.summary ?? []) {
        reasoning += part.text ?? "";
      }
      for (const part of item.content ?? []) {
        reasoning += part.text ?? "";
      }
    } else {
      throw new Error(`Unsupported Responses output: ${item.type}`);
    }
  }
  return {
    id: `chatcmpl_${response.id}`,
    object: "chat.completion",
    created: response.created_at,
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(refusal ? { refusal } : {}),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(reasoningItems.length ? { reasoning_items: reasoningItems } : {}),
          ...(images.length ? { images } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason:
          response.status === "incomplete"
            ? response.incomplete_details?.reason === "content_filter"
              ? "content_filter"
              : "length"
            : calls.length
              ? "tool_calls"
              : "stop",
      },
    ],
    ...(response.usage ? { usage: chatUsage(response.usage) } : {}),
  };
}

async function* chatStreamToResponses(
  upstream: Response,
  request: JSONBody,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (!upstream.body) {
    throw new Error("Upstream response has no stream");
  }
  let sequence = 0,
    created = false,
    terminal = false;
  let response: JSONBody = {
    id: `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: request.model,
    status: "in_progress",
    output: [],
    usage: null,
    error: null,
    incomplete_details: null,
  };
  const output: JSONBody[] = [],
    calls = new Map<number, number>();
  let messageIndex: number | undefined, reasoningIndex: number | undefined;
  let finish = "stop";
  const emit = (type: string, data: JSONBody) =>
    encodeSSE(type, { type, sequence_number: sequence++, ...data });
  for await (const event of parseSSE(upstream.body, signal)) {
    if (event.data === "[DONE]") {
      terminal = true;
      break;
    }
    const chunk = JSON.parse(event.data);
    if (chunk.error) {
      yield emit("error", chunk.error);
      return;
    }
    if (!created) {
      response = {
        ...response,
        id: `resp_${chunk.id ?? crypto.randomUUID()}`,
        model: chunk.model ?? request.model,
        created_at: chunk.created ?? response.created_at,
      };
      yield emit("response.created", { response });
      yield emit("response.in_progress", { response });
      created = true;
    }
    if (chunk.usage) {
      response.usage = responseUsage(chunk.usage);
    }
    for (const choice of chunk.choices ?? []) {
      if (choice.index !== 0) {
        throw new Error("Translated streams support one completion choice");
      }
      if (choice.finish_reason) {
        finish = choice.finish_reason;
        terminal = true;
      }
      const delta = choice.delta ?? {};
      if (delta.content || delta.refusal) {
        if (messageIndex === undefined) {
          messageIndex = output.length;
          const item = {
            id: `msg_${response.id}`,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [] as JSONBody[],
          };
          output.push(item);
          yield emit("response.output_item.added", {
            output_index: messageIndex,
            item: { ...item, content: [] },
          });
        }
        const item = output[messageIndex];
        const partType = delta.refusal ? "refusal" : "output_text";
        let contentIndex = item.content.findIndex((part: JSONBody) => part.type === partType);
        if (contentIndex < 0) {
          contentIndex = item.content.length;
          const part =
            partType === "refusal"
              ? { type: "refusal", refusal: "" }
              : { type: "output_text", text: "", annotations: [] };
          item.content.push(part);
          yield emit("response.content_part.added", {
            item_id: item.id,
            output_index: messageIndex,
            content_index: contentIndex,
            part: { ...part },
          });
        }
        const part = item.content[contentIndex],
          text = delta.refusal ?? delta.content;
        part[partType === "refusal" ? "refusal" : "text"] += text;
        yield emit(
          partType === "refusal" ? "response.refusal.delta" : "response.output_text.delta",
          {
            item_id: item.id,
            output_index: messageIndex,
            content_index: contentIndex,
            delta: text,
          },
        );
      }
      for (const image of delta.images ?? []) {
        const item = imageOutput(image),
          outputIndex = output.length;
        output.push(item);
        yield emit("response.output_item.added", {
          output_index: outputIndex,
          item: { ...item, status: "in_progress", result: null },
        });
        yield emit("response.image_generation_call.in_progress", {
          item_id: item.id,
          output_index: outputIndex,
        });
        yield emit("response.image_generation_call.completed", {
          item_id: item.id,
          output_index: outputIndex,
        });
      }
      for (const call of delta.tool_calls ?? []) {
        let outputIndex = calls.get(call.index);
        if (outputIndex === undefined) {
          outputIndex = output.length;
          calls.set(call.index, outputIndex);
          const item = {
            id: `fc_${call.id ?? crypto.randomUUID()}`,
            type: "function_call",
            status: "in_progress",
            call_id: call.id ?? "",
            name: call.function?.name ?? "",
            arguments: "",
          };
          output.push(item);
          yield emit("response.output_item.added", {
            output_index: outputIndex,
            item: { ...item },
          });
        }
        const item = output[outputIndex];
        if (call.thought_signature) item.thought_signature = call.thought_signature;
        if (call.id) {
          item.call_id = call.id;
        }
        if (call.function?.name && item.name !== call.function.name) {
          item.name += call.function.name;
        }
        if (call.function?.arguments) {
          item.arguments += call.function.arguments;
          yield emit("response.function_call_arguments.delta", {
            item_id: item.id,
            output_index: outputIndex,
            delta: call.function.arguments,
          });
        }
      }
      if (delta.reasoning_content || delta.reasoning_blocks?.length) {
        if (reasoningIndex === undefined) {
          reasoningIndex = output.length;
          const item = {
            id: `rs_${response.id}`,
            type: "reasoning",
            status: "in_progress",
            summary: [] as JSONBody[],
          };
          output.push(item);
          yield emit("response.output_item.added", {
            output_index: reasoningIndex,
            item: { ...item, summary: [] },
          });
          const part = { type: "summary_text", text: "" };
          item.summary.push(part);
          yield emit("response.reasoning_summary_part.added", {
            item_id: item.id,
            output_index: reasoningIndex,
            summary_index: 0,
            part: { ...part },
          });
        }
        const item = output[reasoningIndex];
        if (delta.reasoning_blocks?.length) {
          const blocks = (item.reasoning_blocks ??= []);
          for (const block of delta.reasoning_blocks) {
            const last = blocks.at(-1);
            if (last?.thought && block.thought && !last.thoughtSignature) {
              const text = last.text + block.text;
              Object.assign(last, block, { text });
            } else blocks.push({ ...block });
          }
          item.encrypted_content = seal(reasoningPrefix, {
            reasoning_blocks: item.reasoning_blocks,
          });
        }
        if (delta.reasoning_content) {
          item.summary[0].text += delta.reasoning_content ?? "";
          yield emit("response.reasoning_summary_text.delta", {
            item_id: item.id,
            output_index: reasoningIndex,
            summary_index: 0,
            delta: delta.reasoning_content,
          });
        }
      }
    }
  }
  for (const item of output) delete item.reasoning_blocks;
  if (!terminal) {
    throw new Error("Upstream Chat stream ended before completion");
  }
  if (!created) {
    throw new Error("Upstream Chat stream contained no completion");
  }
  for (const [index, item] of output.entries()) {
    item.status = "completed";
    if (item.type === "message") {
      for (const [contentIndex, part] of item.content.entries()) {
        yield emit(
          part.type === "refusal" ? "response.refusal.done" : "response.output_text.done",
          {
            item_id: item.id,
            output_index: index,
            content_index: contentIndex,
            ...(part.type === "refusal" ? { refusal: part.refusal } : { text: part.text }),
          },
        );
        yield emit("response.content_part.done", {
          item_id: item.id,
          output_index: index,
          content_index: contentIndex,
          part,
        });
      }
    } else if (item.type === "reasoning") {
      yield emit("response.reasoning_summary_text.done", {
        item_id: item.id,
        output_index: index,
        summary_index: 0,
        text: item.summary[0].text,
      });
      yield emit("response.reasoning_summary_part.done", {
        item_id: item.id,
        output_index: index,
        summary_index: 0,
        part: item.summary[0],
      });
    } else if (item.type === "function_call") {
      yield emit("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: index,
        arguments: item.arguments,
      });
    }
    yield emit("response.output_item.done", { output_index: index, item });
  }
  const incomplete = finish === "length" || finish === "content_filter";
  response = {
    ...response,
    output,
    status: incomplete ? "incomplete" : "completed",
    incomplete_details: incomplete
      ? { reason: finish === "length" ? "max_output_tokens" : "content_filter" }
      : null,
  };
  yield emit(incomplete ? "response.incomplete" : "response.completed", { response });
}

async function* responsesStreamToChat(
  upstream: Response,
  request: JSONBody,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (!upstream.body) {
    throw new Error("Upstream response has no stream");
  }
  let id = `chatcmpl_${crypto.randomUUID()}`,
    created = Math.floor(Date.now() / 1000),
    model = request.model,
    sentRole = false,
    finished = false;
  const calls = new Map<string, number>();
  const chunk = (delta: JSONBody, finish_reason: string | null = null, usage?: JSONBody) =>
    encodeSSE(undefined, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: usage ? [] : [{ index: 0, delta, finish_reason }],
      ...(usage ? { usage } : {}),
    });
  for await (const event of parseSSE(upstream.body, signal)) {
    if (event.data === "[DONE]") {
      break;
    }
    const value = JSON.parse(event.data),
      type = value.type ?? event.event;
    if (value.response) {
      id = `chatcmpl_${value.response.id}`;
      created = value.response.created_at;
      model = value.response.model ?? model;
    }
    if (!sentRole) {
      yield chunk({ role: "assistant", content: "" });
      sentRole = true;
    }
    if (type === "response.output_text.delta") {
      yield chunk({ content: value.delta });
    } else if (
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta"
    ) {
      yield chunk({ reasoning_content: value.delta });
    } else if (
      type === "response.output_item.done" &&
      value.item.type === "image_generation_call" &&
      value.item.result
    ) {
      yield chunk({
        images: [{ type: "image_url", image_url: { url: imageDataURL(value.item) } }],
      });
    } else if (
      type === "response.output_item.done" &&
      value.item.type === "reasoning" &&
      value.item.encrypted_content
    ) {
      yield chunk({ reasoning_items: [value.item] });
    } else if (
      type === "response.output_item.done" &&
      value.item.type === "function_call" &&
      value.item.thought_signature
    ) {
      yield chunk({
        tool_calls: [
          { index: calls.get(value.item.id), thought_signature: value.item.thought_signature },
        ],
      });
    } else if (type === "response.refusal.delta") {
      yield chunk({ refusal: value.delta });
    } else if (type === "response.output_item.added" && value.item.type === "function_call") {
      const index = calls.size;
      calls.set(value.item.id, index);
      yield chunk({
        tool_calls: [
          {
            index,
            id: value.item.call_id,
            type: "function",
            function: { name: value.item.name, arguments: "" },
          },
        ],
      });
    } else if (type === "response.function_call_arguments.delta") {
      const index = calls.get(value.item_id);
      if (index === undefined) {
        throw new Error("Arguments arrived before function call");
      }
      yield chunk({ tool_calls: [{ index, function: { arguments: value.delta } }] });
    } else if (type === "response.completed" || type === "response.incomplete") {
      finished = true;
      yield chunk(
        {},
        type === "response.incomplete"
          ? value.response.incomplete_details?.reason === "content_filter"
            ? "content_filter"
            : "length"
          : calls.size
            ? "tool_calls"
            : "stop",
      );
      if (request.stream_options?.include_usage && value.response.usage) {
        yield chunk({}, null, chatUsage(value.response.usage));
      }
      yield encodeSSE(undefined, "[DONE]");
      return;
    } else if (type === "error" || type === "response.failed") {
      yield encodeSSE(undefined, {
        error: value.error ??
          value.response?.error ?? { message: "Upstream response failed", type: "provider_error" },
      });
      return;
    }
  }
  if (!finished) {
    throw new Error("Upstream Responses stream ended before completion");
  }
}

/** Collect Responses SSE; providers that require streaming can specify it explicitly. */
export async function normalizeResponsesResponse(
  response: Response,
  signal?: AbortSignal,
  stream = response.headers.get("content-type")?.includes("text/event-stream") === true,
): Promise<Response> {
  if (!response.ok) {
    return response;
  }
  if (!response.body)
    return stream ? protocolError("Upstream response has no body", 502) : response;
  if (!stream) {
    // Inspect the prefix without waiting for an SSE connection to close.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    const decoder = new TextDecoder();
    let prefix = "";
    const abort = () => {
      void reader.cancel(signal?.reason).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (!prefix.trimStart()) {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        signal?.throwIfAborted();
        if (chunk.done) break;
        chunks.push(chunk.value);
        prefix += decoder.decode(chunk.value, { stream: true });
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    stream = /^[deir:]/.test(prefix.trimStart());
    response = new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
          },
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                reader.releaseLock();
                controller.close();
              } else controller.enqueue(chunk.value);
            } catch (error) {
              reader.releaseLock();
              controller.error(error);
            }
          },
          async cancel(reason) {
            await reader.cancel(reason);
            reader.releaseLock();
          },
        },
        { highWaterMark: 0 },
      ),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
    if (!stream) return response;
  }
  for await (const event of parseSSE(response.body!, signal)) {
    if (event.data === "[DONE]") {
      break;
    }
    const value = JSON.parse(event.data);
    if (value.type === "response.completed" || value.type === "response.incomplete") {
      return Response.json(value.response, {
        status: response.status,
        headers: translatedHeaders(response),
      });
    }
    if (value.type === "response.failed" || value.type === "error") {
      return Response.json(
        { error: value.response?.error ?? value.error ?? value },
        { status: 502 },
      );
    }
  }
  return protocolError("Upstream stream ended before completing a response", 502);
}

export async function executeResponses(
  request: Request,
  fetchNative: NativeFetch,
  allowCompact = false,
): Promise<Response> {
  let body: JSONBody, translated: JSONBody;
  let compact = new URL(request.url).pathname.endsWith("/responses/compact");
  try {
    body = (await request.json()) as JSONBody;
    if (compact && body.stream)
      return protocolError("Streaming compact is unsupported; use a Responses compaction_trigger");
    compact ||=
      Array.isArray(body.input) &&
      body.input.some((item: JSONBody) => item.type === "compaction_trigger");
    if (compact && !allowCompact)
      return protocolError("Compaction is unsupported for this provider", 404);
    if (compact) {
      const input =
        typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
      if (!Array.isArray(input)) throw new Error("Compaction input must be text or an array");
      const summaryBody: JSONBody = {
        ...body,
        stream: false,
        input: [
          ...input.filter((item: JSONBody) => item.type !== "compaction_trigger"),
          {
            role: "user",
            content:
              "Please provide a concise and comprehensive summary of the preceding conversation and task progress so far, including user goals, key findings, actions taken, and current status, so that work can continue smoothly.",
          },
        ],
      };
      for (const field of [
        "tool_choice",
        "previous_response_id",
        "parallel_tool_calls",
        "additional_tools",
        "truncation",
        "metadata",
      ])
        delete summaryBody[field];
      translated = responsesToChat(summaryBody);
      if (translated.tools?.length) translated.tool_choice = "none";
      else
        for (const message of translated.messages) {
          if (message.role === "tool") {
            message.role = "user";
            message.content = `Tool result ${message.tool_call_id}: ${message.content}`;
            delete message.tool_call_id;
          }
          if (message.tool_calls?.length) {
            const text = message.tool_calls
              .map(
                (call: JSONBody) =>
                  `Tool call ${call.function.name} (${call.id}): ${call.function.arguments}`,
              )
              .join("\n");
            message.content = Array.isArray(message.content)
              ? [...message.content, { type: "text", text }]
              : [message.content, text].filter(Boolean).join("\n");
            delete message.tool_calls;
          }
        }
    } else translated = responsesToChat(body);
  } catch (error) {
    return protocolError(error instanceof Error ? error.message : "Invalid request");
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const response = await fetchNative(translated, signal);
  if (!response.ok) {
    return response;
  }
  if (body.stream && !compact) {
    return streamSSE(chatStreamToResponses(response, body, signal), response, () =>
      controller.abort(),
    );
  }
  try {
    const completion = (await response.json()) as JSONBody;
    if (compact) {
      const summary = completion.choices?.[0]?.message?.content;
      if (
        typeof summary !== "string" ||
        !summary.trim() ||
        completion.choices[0].finish_reason === "length"
      )
        throw new Error("Incomplete compaction summary");
      const item = {
        id: `cmp_${crypto.randomUUID()}`,
        type: "compaction",
        status: "completed",
        encrypted_content: seal(compactionPrefix, {
          summary,
          model: body.model,
          created_at: Math.floor(Date.now() / 1000),
        }),
      };
      const value = {
        id: `resp_${crypto.randomUUID()}`,
        object: "response.compaction",
        status: "completed",
        created_at: Math.floor(Date.now() / 1000),
        model: body.model,
        output: [item],
        usage: responseUsage(completion.usage),
      };
      if (body.stream) {
        async function* events() {
          const frames: [string, JSONBody][] = [
            ["response.created", { response: { ...value, status: "in_progress", output: [] } }],
            [
              "response.output_item.added",
              { output_index: 0, item: { ...item, status: "in_progress" } },
            ],
            ["response.output_item.done", { output_index: 0, item }],
            ["response.completed", { response: value }],
          ];
          for (const [sequence_number, [type, data]] of frames.entries())
            yield encodeSSE(type, { type, sequence_number, ...data });
        }
        return streamSSE(events(), response);
      }
      return Response.json(value, { headers: translatedHeaders(response) });
    }
    return Response.json(chatCompletionToResponse(completion, body), {
      status: response.status,
      headers: translatedHeaders(response),
    });
  } catch {
    return protocolError("Invalid upstream Chat completion", 502);
  }
}

export async function executeChat(request: Request, fetchNative: NativeFetch): Promise<Response> {
  let body: JSONBody, translated: JSONBody;
  try {
    body = (await request.json()) as JSONBody;
    translated = chatToResponses(body);
  } catch (error) {
    return protocolError(error instanceof Error ? error.message : "Invalid request");
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const response = await fetchNative(translated, signal);
  if (!response.ok) {
    return response;
  }
  if (body.stream) {
    return streamSSE(responsesStreamToChat(response, body, signal), response, () =>
      controller.abort(),
    );
  }
  const normalized = await normalizeResponsesResponse(response, request.signal);
  if (!normalized.ok) {
    return normalized;
  }
  try {
    return Response.json(responseToChatCompletion(await normalized.json()), {
      status: response.status,
      headers: translatedHeaders(response),
    });
  } catch {
    return protocolError("Invalid upstream Responses completion", 502);
  }
}
