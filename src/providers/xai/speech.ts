import { protocolError, rejectFields } from "../../protocols/openai.js";
import type { ProviderContext } from "../contract.js";

const voices: Record<string, string> = {
  alloy: "ara",
  ash: "orion",
  ballad: "luna",
  coral: "celeste",
  echo: "rex",
  fable: "sal",
  onyx: "leo",
  nova: "eve",
  sage: "iris",
  shimmer: "aurora",
  verse: "lumen",
};
export async function executeSpeech(
  request: Request,
  headers: Headers,
  context: ProviderContext,
): Promise<Response> {
  if (request.method !== "POST") return protocolError("Speech requires POST", 405);
  let payload: Record<string, unknown>, codec: string;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 1024 * 1024) return protocolError("Speech body exceeds 1MB");
    const body = JSON.parse(raw);
    rejectFields(body, [
      "model",
      "input",
      "text",
      "voice",
      "voice_id",
      "language",
      "speed",
      "response_format",
      "output_format",
    ]);
    const model = String(body.model ?? "")
      .trim()
      .toLowerCase()
      .replace(/^(?:xai|x-ai|grok)\//, "");
    if (
      !["", "tts-1", "tts-1-hd", "gpt-4o-mini-tts", "grok-tts", "grok-voice-tts-1.0"].includes(
        model,
      )
    )
      throw new Error("Unsupported speech model");
    const text = body.input ?? body.text;
    if (typeof text !== "string" || !text.trim() || [...text.trim()].length > 60000)
      throw new Error("Speech input must contain 1 to 60000 characters");
    if (
      body.output_format !== undefined &&
      (!body.output_format ||
        typeof body.output_format !== "object" ||
        Array.isArray(body.output_format))
    )
      throw new Error("Invalid speech output_format");
    codec = String(body.response_format ?? body.output_format?.codec ?? "mp3").toLowerCase();
    if (!["mp3", "wav", "pcm"].includes(codec)) throw new Error("Speech supports mp3, wav and pcm");
    const voice = String(body.voice ?? body.voice_id ?? "eve")
      .trim()
      .toLowerCase();
    payload = {
      text: text.trim(),
      voice_id: voices[voice] ?? voice,
      language: body.language ?? "auto",
    };
    if (body.speed !== undefined) {
      if (typeof body.speed !== "number" || !Number.isFinite(body.speed) || body.speed <= 0)
        throw new Error("Invalid speech speed");
      payload.speed = body.speed;
    }
    if (codec !== "mp3") {
      const rate = body.output_format?.sample_rate ?? 24000;
      if (!Number.isSafeInteger(rate) || rate <= 0) throw new Error("Invalid speech sample rate");
      payload.output_format = { codec, sample_rate: rate };
    }
  } catch (error) {
    return protocolError(error instanceof Error ? error.message : "Invalid speech request");
  }
  headers.set("Accept", "*/*");
  const response = await context.fetch("https://api.x.ai/v1/tts", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.any([request.signal, context.signal]),
    redirect: "error",
  });
  if (!response.ok || response.headers.has("content-type")) return response;
  const outputHeaders = new Headers(response.headers);
  outputHeaders.set("content-type", codec === "mp3" ? "audio/mpeg" : `audio/${codec}`);
  return new Response(response.body, { status: response.status, headers: outputHeaders });
}
