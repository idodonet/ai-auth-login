import type { ProviderContext } from "../contract.js";
import { protocolError } from "../../protocols/openai.js";
import { parseSSE, encodeSSE, streamSSE } from "../../protocols/sse.js";

type Body = Record<string, any>;
const directModels = new Set([
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5",
]);
const stringFields = [
  "size",
  "quality",
  "background",
  "output_format",
  "input_fidelity",
  "moderation",
];
const numberFields = ["output_compression", "partial_images"];
const allowed = [
  "model",
  "prompt",
  "n",
  "stream",
  "response_format",
  "user",
  "images",
  "image",
  "mask",
  ...stringFields,
  ...numberFields,
];
const maxInput = 32 * 1024 * 1024;
const mime = (format: unknown) =>
  format === "jpeg" || format === "jpg"
    ? "image/jpeg"
    : format === "webp"
      ? "image/webp"
      : "image/png";
function output(result: string, format: unknown, url: boolean): Body {
  return url ? { url: `data:${mime(format)};base64,${result}` } : { b64_json: result };
}
function cleanHeaders(response: Response): Headers {
  const h = new Headers(response.headers);
  for (const key of ["content-length", "content-encoding", "transfer-encoding"]) {
    h.delete(key);
  }
  h.set("content-type", "application/json");
  return h;
}
async function boundedRequest(request: Request, signal: AbortSignal): Promise<Request> {
  if (Number(request.headers.get("content-length")) > maxInput) {
    throw new Error("Image request exceeds 32 MiB");
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw new Error("Image request body is required");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) {
        break;
      }
      size += item.value.byteLength;
      if (size > maxInput) {
        throw new Error("Image request exceeds 32 MiB");
      }
      chunks.push(item.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: bytes,
    signal,
  });
}
async function dataURL(file: Blob): Promise<string> {
  const bytes = Buffer.from(await file.arrayBuffer());
  const detected = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : bytes.toString("ascii", 0, 3) === "GIF"
          ? "image/gif"
          : null;
  const type = detected ?? file.type;
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type)) {
    throw new Error("Image uploads must be PNG, JPEG, WebP, or GIF");
  }
  return `data:${type};base64,${bytes.toString("base64")}`;
}
async function parse(request: Request, edit: boolean, signal: AbortSignal): Promise<Body> {
  const copy = await boundedRequest(request, signal);
  if (!copy.headers.get("content-type")?.startsWith("multipart/form-data")) {
    const body = await copy.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Image request must be a JSON object");
    }
    return body as Body;
  }
  if (!edit) {
    throw new Error("Image generation requires JSON");
  }
  const form = await copy.formData();
  const body: Body = {};
  const images: Body[] = [];
  for (const [key, value] of form) {
    if (value instanceof Blob) {
      if (["image", "image[]", "images", "images[]"].includes(key)) {
        images.push({ image_url: await dataURL(value) });
      } else if (key === "mask") {
        body.mask = { image_url: await dataURL(value) };
      } else {
        throw new Error(`Unsupported image upload field: ${key}`);
      }
    } else if (key === "mask[image_url]" || key === "mask[file_id]") {
      body.mask ??= {};
      body.mask[key === "mask[file_id]" ? "file_id" : "image_url"] = value;
    } else if (["n", ...numberFields].includes(key)) {
      if (!/^\d+$/.test(value)) {
        throw new Error(`Invalid integer image option: ${key}`);
      }
      body[key] = Number(value);
    } else if (key === "stream") {
      body.stream = value === "true";
    } else if (key === "images" || key === "images[]") {
      let image: unknown;
      try {
        image = JSON.parse(value);
      } catch {
        throw new Error("Invalid image JSON");
      }
      if (Array.isArray(image)) {
        images.push(...image);
      } else {
        images.push(image as Body);
      }
    } else {
      body[key] = value;
    }
  }
  if (images.length) {
    body.images = images;
  }
  return body;
}
function validate(body: Body, edit: boolean, direct: boolean): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unsupported image option: ${key}`);
    }
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    throw new Error("Image prompt is required");
  }
  if (body.model !== undefined && typeof body.model !== "string") {
    throw new Error("Image model must be a string");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new Error("Image stream must be a boolean");
  }
  if (body.response_format !== undefined && !["url", "b64_json"].includes(body.response_format)) {
    throw new Error("Unsupported image response format");
  }
  if (body.n !== undefined && (!Number.isInteger(body.n) || body.n < 1 || body.n > 10)) {
    throw new Error("Image n must be an integer between 1 and 10");
  }
  if (!direct && body.n !== undefined && body.n !== 1) {
    throw new Error("Responses image generation supports n=1");
  }
  for (const key of stringFields) {
    if (body[key] !== undefined && typeof body[key] !== "string") {
      throw new Error(`Image ${key} must be a string`);
    }
  }
  for (const key of numberFields) {
    if (body[key] !== undefined && (!Number.isInteger(body[key]) || body[key] < 0)) {
      throw new Error(`Image ${key} must be a nonnegative integer`);
    }
  }
  if (body.output_compression > 100 || body.partial_images > 3) {
    throw new Error("Image output_compression must be at most 100 and partial_images at most 3");
  }
  if (body.image !== undefined) {
    if (!Array.isArray(body.images)) {
      body.images = [];
    }
    for (const image of Array.isArray(body.image) ? body.image : [body.image]) {
      body.images.push(typeof image === "string" ? { image_url: image } : image);
    }
    delete body.image;
  }
  if (edit && (!Array.isArray(body.images) || !body.images.length)) {
    throw new Error("Image edit requires at least one image");
  }
  if (
    !edit &&
    (body.images !== undefined || body.mask !== undefined || body.input_fidelity !== undefined)
  ) {
    throw new Error("Image inputs, masks, and input_fidelity require an edit request");
  }
  if (body.images !== undefined) {
    if (!Array.isArray(body.images)) {
      throw new Error("Images must be an array");
    }
    for (const image of body.images) {
      if (
        !image ||
        typeof image !== "object" ||
        Object.keys(image).some((k) => !["image_url", "file_id"].includes(k))
      ) {
        throw new Error("Invalid image input");
      }
      if (typeof image.image_url !== "string" && !(direct && typeof image.file_id === "string")) {
        throw new Error("Image input requires an image_url");
      }
    }
  }
  if (body.mask !== undefined) {
    if (
      !body.mask ||
      typeof body.mask !== "object" ||
      Array.isArray(body.mask) ||
      Object.keys(body.mask).some((k) => !["image_url", "file_id"].includes(k))
    ) {
      throw new Error("Invalid image mask");
    }
    if (
      typeof body.mask.image_url !== "string" &&
      !(direct && typeof body.mask.file_id === "string")
    ) {
      throw new Error("Image mask requires an image_url");
    }
  }
  // The tool path has no user field. Reject it rather than silently dropping intent.
  if (!direct && body.user !== undefined) {
    throw new Error("Responses image generation does not support user");
  }
}
function toolRequest(body: Body, edit: boolean): Body {
  const tool: Body = {
    type: "image_generation",
    action: edit ? "edit" : "generate",
    model: body.model ?? "gpt-image-2",
  };
  for (const key of [...stringFields, ...numberFields]) {
    if (body[key] !== undefined) {
      tool[key] = body[key];
    }
  }
  if (body.mask) {
    tool.input_image_mask = body.mask;
  }
  return {
    model: "gpt-5.4-mini",
    instructions: "",
    stream: true,
    store: false,
    reasoning: { effort: "medium", summary: "auto" },
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    tool_choice: { type: "image_generation" },
    tools: [tool],
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: body.prompt.trim() },
          ...(body.images ?? []).map((image: Body) => ({
            type: "input_image",
            image_url: image.image_url,
          })),
        ],
      },
    ],
  };
}
function completed(event: Body, indexed: Map<number, Body>, fallback: Body[], url: boolean): Body {
  const result = event.response;
  const items: Body[] =
    Array.isArray(result?.output) && result.output.length
      ? result.output
      : [...[...indexed].sort(([a], [b]) => a - b).map(([, item]) => item), ...fallback];
  const images = items.filter(
    (item) =>
      item.type === "image_generation_call" &&
      typeof item.result === "string" &&
      item.result.length,
  );
  if (!images.length) {
    throw new Error("Codex returned no image output");
  }
  const body: Body = {
    created: result?.created_at ?? Math.floor(Date.now() / 1000),
    data: images.map((image) => ({
      ...output(image.result, image.output_format, url),
      ...(image.revised_prompt ? { revised_prompt: image.revised_prompt } : {}),
    })),
  };
  for (const key of ["background", "output_format", "quality", "size"]) {
    if (images[0]?.[key]) {
      body[key] = images[0][key];
    }
  }
  if (result?.tool_usage?.image_gen) {
    body.usage = result.tool_usage.image_gen;
  }
  return body;
}
export async function executeImages(
  request: Request,
  baseURL: string,
  authHeaders: Headers,
  context: ProviderContext,
): Promise<Response> {
  const edit = new URL(request.url).pathname.endsWith("/edits");
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, context.signal, controller.signal]);
  let body: Body;
  try {
    body = await parse(request, edit, signal);
    const model =
      typeof body.model === "string"
        ? body.model.trim().split("/").at(-1)!.toLowerCase()
        : "gpt-image-2";
    body.model = model;
    validate(body, edit, directModels.has(model));
  } catch (error) {
    signal.throwIfAborted();
    return protocolError(error instanceof Error ? error.message : "Invalid image request");
  }
  const direct = directModels.has(body.model);
  const headers = new Headers(authHeaders);
  headers.set("content-type", "application/json");
  headers.set("accept", direct && !body.stream ? "application/json" : "text/event-stream");
  const response = await context.fetch(
    `${baseURL}${direct ? (edit ? "/images/edits" : "/images/generations") : "/responses"}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(direct ? body : toolRequest(body, edit)),
      signal,
    },
  );
  if (!response.ok || direct) {
    return response;
  }
  if (!response.body) {
    return protocolError("Codex image response has no body", 502);
  }
  const events = parseSSE(response.body, signal);
  const indexed = new Map<number, Body>();
  const fallback: Body[] = [];
  const url = body.response_format === "url";
  const prefix = edit ? "image_edit" : "image_generation";
  async function* frames(): AsyncGenerator<Uint8Array> {
    for await (const item of events) {
      if (item.data === "[DONE]") {
        break;
      }
      const event = JSON.parse(item.data) as Body;
      if (indexed.size + fallback.length > 256) {
        throw new Error("Codex returned too many image output items");
      }
      if (event.type === "response.output_item.done" && event.item) {
        if (typeof event.output_index === "number") {
          indexed.set(event.output_index, event.item);
        } else {
          fallback.push(event.item);
        }
      }
      if (
        event.type === "response.image_generation_call.partial_image" &&
        typeof event.partial_image_b64 === "string"
      ) {
        yield encodeSSE(`${prefix}.partial_image`, {
          type: `${prefix}.partial_image`,
          partial_image_index: event.partial_image_index ?? 0,
          ...output(event.partial_image_b64, event.output_format, url),
        });
      }
      if (event.type === "response.completed") {
        const result = completed(event, indexed, fallback, url);
        if (body.stream) {
          for (const image of result.data) {
            yield encodeSSE(`${prefix}.completed`, {
              type: `${prefix}.completed`,
              ...image,
              ...(result.usage ? { usage: result.usage } : {}),
            });
          }
        } else {
          yield new TextEncoder().encode(JSON.stringify(result));
        }
        return;
      }
      if (event.type === "response.failed" || event.type === "error") {
        throw new Error("Codex image generation failed");
      }
    }
    throw new Error("Codex image stream ended before completion");
  }
  if (body.stream) {
    return streamSSE(frames(), response, () => controller.abort());
  }
  try {
    for await (const frame of frames()) {
      if (frame[0] === 123) {
        return new Response(new Uint8Array(frame), {
          status: response.status,
          headers: cleanHeaders(response),
        });
      }
    }
  } catch {
    signal.throwIfAborted();
    return protocolError("Codex image generation failed or ended before completion", 502);
  }
  return protocolError("Codex returned no image output", 502);
}
