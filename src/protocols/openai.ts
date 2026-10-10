import { normalizeResponsesResponse } from "./responses.js";

export type JSONBody = Record<string, any>;
export type NativeFetch = (body: JSONBody, signal: AbortSignal) => Promise<Response>;

export function protocolError(message: string, status = 400): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error", code: "unsupported" } },
    { status },
  );
}

export async function executeOpenAI(request: Request, fetchNative: NativeFetch): Promise<Response> {
  const body = (await request.json()) as JSONBody;
  const response = await fetchNative(body, request.signal);
  return body.stream ? response : normalizeResponsesResponse(response, request.signal);
}

export function rejectFields(body: JSONBody, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (body[key] !== undefined && !allowed.includes(key)) {
      throw new Error(`Unsupported translated request field: ${key}`);
    }
  }
}

export { executeResponses, executeChat, normalizeResponsesResponse } from "./responses.js";

export function translatedHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  for (const key of ["content-length", "content-encoding", "transfer-encoding"]) {
    headers.delete(key);
  }
  headers.set("content-type", "application/json");
  return headers;
}

export async function requestBody(request: Request): Promise<JSONBody | Response> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      return protocolError("Request body must be a JSON object");
    return body;
  } catch {
    return protocolError("Invalid request JSON");
  }
}
