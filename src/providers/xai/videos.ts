import { protocolError } from "../../protocols/openai.js";
import type { ProviderContext } from "../contract.js";

const videoModels = [
  "grok-imagine-video",
  "grok-imagine-video-1.5",
  "grok-imagine-video-1.5-preview",
];
function canonicalModel(value: unknown): string {
  const model = String(value ?? "grok-imagine-video");
  if (model === "sora-2" || model.startsWith("sora-2-")) {
    return videoModels[0]!;
  }
  if (!videoModels.includes(model)) {
    throw new Error("Unsupported xAI video model.");
  }
  return model.replace(/-preview$/, "");
}
async function readBody(request: Request): Promise<Record<string, any>> {
  if (!request.headers.get("content-type")?.includes("form")) {
    return request.json();
  }
  const data: Record<string, unknown> = {};
  for (const [key, value] of await request.formData()) {
    if (typeof value !== "string") {
      throw new Error("Uploaded input_reference files are unsupported; use an image URL.");
    }
    data[key] = value;
  }
  const imageURL =
    data["input_reference[image_url]"] ?? data["input_reference.image_url"] ?? data.image_url;
  const fileID = data["input_reference[file_id]"] ?? data["input_reference.file_id"];
  if (imageURL || fileID) {
    data.input_reference = { image_url: imageURL, file_id: fileID };
  }
  return data;
}
function createBody(input: Record<string, any>) {
  if (typeof input.prompt !== "string" || !input.prompt.trim()) {
    throw new Error("prompt is required.");
  }
  const seconds = String(input.seconds ?? 4);
  if (!/^-?\d+$/.test(seconds)) {
    throw new Error("seconds must be an integer.");
  }
  const duration = Math.max(1, Math.min(15, Number(seconds)));
  const size = String(input.size ?? "720x1280");
  if (!["720x1280", "1280x720", "1024x1792", "1792x1024"].includes(size)) {
    throw new Error("Unsupported video size.");
  }
  if (input.input_reference?.file_id) {
    throw new Error("input_reference.file_id is unsupported; use image_url.");
  }
  const image =
    input.input_reference?.image_url ??
    input.image_url ??
    (typeof input.image === "string"
      ? input.image
      : (input.image?.url ?? input.image?.image_url?.url));
  const references = [
    ...(input.reference_images ?? []),
    ...(Array.isArray(input.reference_image_urls)
      ? input.reference_image_urls
      : typeof input.reference_image_urls === "string"
        ? input.reference_image_urls.split(",")
        : []),
  ].map((item: any) => (typeof item === "string" ? item : (item?.url ?? item?.image_url?.url)));
  if (
    references.length > 7 ||
    references.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error("reference_images requires at most seven image URLs.");
  }
  if (image && references.length) {
    throw new Error("image and reference_images cannot be combined.");
  }
  const aliases: Record<string, string> = { square: "1:1", portrait: "9:16", landscape: "16:9" };
  const ratio =
    aliases[input.aspect_ratio] ??
    input.aspect_ratio ??
    (size === "720x1280" || size === "1024x1792" ? "9:16" : "16:9");
  if (!["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"].includes(ratio)) {
    throw new Error("Unsupported aspect_ratio.");
  }
  const resolution = input.resolution ?? "720p";
  if (!["480p", "720p"].includes(resolution)) {
    throw new Error("Unsupported resolution.");
  }
  return {
    body: {
      model: canonicalModel(input.model),
      prompt: input.prompt.trim(),
      duration,
      aspect_ratio: ratio,
      resolution,
      ...(image ? { image: { url: image } } : {}),
      ...(references.length ? { reference_images: references.map((url) => ({ url })) } : {}),
    },
    size,
  };
}
function jsonHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "application/json");
  return headers;
}
function normalizedVideo(data: Record<string, any>, defaults: Record<string, any> = {}) {
  const id = data.request_id ?? data.id ?? defaults.id;
  if (typeof id !== "string" || !id) {
    throw new Error("xAI returned no video request ID.");
  }
  const statuses: Record<string, string> = {
    queued: "queued",
    pending: "queued",
    processing: "in_progress",
    running: "in_progress",
    in_progress: "in_progress",
    completed: "completed",
    done: "completed",
    succeeded: "completed",
    success: "completed",
    failed: "failed",
    error: "failed",
    expired: "failed",
    cancelled: "failed",
    canceled: "failed",
  };
  return {
    object: "video",
    progress: 0,
    ...defaults,
    ...data,
    id,
    model: canonicalModel(data.model ?? defaults.model),
    status: statuses[data.status] ?? (data.error || data.code ? "failed" : "queued"),
    ...(data.video?.duration !== undefined ? { seconds: String(data.video.duration) } : {}),
    ...(data.video?.url ? { video_url: data.video.url } : {}),
    ...(data.error || data.code
      ? {
          error: {
            code: data.code ?? data.error?.code ?? "video_generation_failed",
            message: data.error?.message ?? String(data.error ?? data.code),
          },
        }
      : {}),
  };
}
export async function executeVideo(
  request: Request,
  base: string,
  headers: Headers,
  context: ProviderContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/v1/, "");
  const signal = AbortSignal.any([request.signal, context.signal]);
  if (request.method === "POST" && request.headers.has("x-idempotency-key")) {
    headers = new Headers(headers);
    headers.set("x-idempotency-key", request.headers.get("x-idempotency-key")!);
  }
  const upstream = (path: string, body?: unknown) =>
    context.fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
      redirect: "error",
    });
  if (
    request.method === "POST" &&
    ["/videos/generations", "/videos/edits", "/videos/extensions"].includes(path)
  ) {
    try {
      const body = await request.json();
      body.model = canonicalModel(body.model);
      return upstream(path, body);
    } catch {
      return protocolError("Invalid native xAI video request.");
    }
  }
  if (path === "/videos" && request.method === "POST") {
    let built: ReturnType<typeof createBody>;
    try {
      built = createBody(await readBody(request));
    } catch (error) {
      return protocolError(error instanceof Error ? error.message : "Invalid video request.");
    }
    const response = await upstream("/videos/generations", built.body);
    if (!response.ok) {
      return response;
    }
    try {
      return Response.json(
        normalizedVideo(await response.json(), {
          model: built.body.model,
          prompt: built.body.prompt,
          seconds: String(built.body.duration),
          size: built.size,
          created_at: Math.floor(Date.now() / 1000),
        }),
        { status: response.status, headers: jsonHeaders(response) },
      );
    } catch {
      return protocolError("Invalid xAI video response.", 502);
    }
  }
  const match = /^\/videos\/([^/]+)(\/content)?$/.exec(path);
  if (!match || request.method !== "GET") {
    return protocolError(
      "xAI supports video create, retrieve, and download; list, delete, remix and edit SDK operations are unavailable.",
      404,
    );
  }
  let id: string;
  try {
    id = decodeURIComponent(match[1]!);
  } catch {
    return protocolError("Invalid video ID.");
  }
  if (!id || /[\/\\\x00-\x1f]/.test(id)) {
    return protocolError("Invalid video ID.");
  }
  if (match[2] && url.searchParams.has("variant") && url.searchParams.get("variant") !== "video") {
    return protocolError("xAI provides only the video content variant.");
  }
  const response = await upstream(`/videos/${encodeURIComponent(id)}`);
  if (!response.ok) {
    return response;
  }
  let data: Record<string, any>;
  try {
    data = await response.json();
  } catch {
    return protocolError("Invalid xAI video response.", 502);
  }
  if (!match[2]) {
    try {
      return Response.json(normalizedVideo(data, { id, model: "grok-imagine-video" }), {
        status: response.status,
        headers: jsonHeaders(response),
      });
    } catch {
      return protocolError("Invalid xAI video response.", 502);
    }
  }
  let contentURL: URL;
  try {
    contentURL = new URL(data.video?.url);
    if (
      contentURL.protocol !== "https:" ||
      contentURL.username ||
      contentURL.password ||
      contentURL.port ||
      !["x.ai", "grok.com"].some(
        (domain) => contentURL.hostname === domain || contentURL.hostname.endsWith(`.${domain}`),
      )
    ) {
      throw new Error();
    }
  } catch {
    return protocolError("Untrusted xAI video download URL.", 502);
  }
  // Signed media URLs need no provider credentials. Redirects must not escape this trust boundary.
  return context.fetch(contentURL, { signal, redirect: "error" });
}
