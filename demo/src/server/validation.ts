import { ProviderSession } from "ai-auth-login";
import type { ChatRequest, TabAction } from "../shared/types.js";
import { MAX_CHAT_MESSAGES } from "../shared/chat.js";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 262_144): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const providers = new Set(ProviderSession.listProviders().map((provider) => provider.id));
export function validAction(value: unknown): value is TabAction {
  if (!record(value)) {
    return false;
  }
  switch (value.type) {
    case "restore":
      return value.state === undefined || text(value.state);
    case "begin-auth":
      return (
        providers.has(value.provider as never) &&
        (value.method === undefined || value.method === "callback" || value.method === "device")
      );
    case "complete-auth":
      return text(value.callbackURL, 16_384);
    case "wait-auth":
    case "cancel-auth":
    case "refresh":
    case "logout":
    case "close":
      return true;
    case "connect": {
      if (!providers.has(value.provider as never) || !record(value.credentials)) {
        return false;
      }
      const credentials = value.credentials;
      for (const key of ["project", "location", "baseURL", "url", "token"]) {
        if (credentials[key] !== undefined && !text(credentials[key], 16_384)) {
          return false;
        }
      }
      if (
        credentials.headers !== undefined &&
        (!record(credentials.headers) ||
          Object.entries(credentials.headers).some(
            ([key, val]) =>
              !/^[\w-]{1,128}$/.test(key) ||
              typeof val !== "string" ||
              val.length > 8192 ||
              /[\r\n]/.test(val),
          ))
      ) {
        return false;
      }
      if (credentials.kind === "api-key") {
        return text(credentials.apiKey, 16_384);
      }
      if (credentials.kind === "service-account") {
        return text(credentials.serviceAccount) || record(credentials.serviceAccount);
      }
      return credentials.kind === "relay";
    }
    default:
      return false;
  }
}
export function validChat(value: unknown): value is ChatRequest {
  return (
    record(value) &&
    text(value.model, 256) &&
    Array.isArray(value.messages) &&
    value.messages.length > 0 &&
    value.messages.length <= MAX_CHAT_MESSAGES &&
    value.messages.every(
      (message) =>
        record(message) &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.length <= 100_000,
    )
  );
}
