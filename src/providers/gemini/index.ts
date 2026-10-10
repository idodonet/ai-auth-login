import { ok, fail } from "../../result.js";
import type { ProviderAdapter, CredentialState, ProviderContext } from "../contract.js";
import type { ConnectCredentials, Model } from "../../types.js";
import { geminiCountBody, executeGemini, executeInteractions } from "../../protocols/gemini.js";

const makeGemini = (interactions: boolean): ProviderAdapter => {
  const provider = interactions ? "gemini-interactions" : "gemini";
  return {
    descriptor: {
      id: provider,
      name: interactions ? "Gemini Interactions" : "Gemini",
      authMethods: ["api-key"],
      endpoints: [
        "models",
        "chat.completions",
        "responses",
        "count_tokens",
        ...(interactions ? ["interactions" as const] : ["generateContent" as const]),
      ],
      quota: false,
      modelDiscovery: "live",
    },
    async beginAuth() {
      return fail("unsupported", "Gemini requires an API key.");
    },
    async connect(input: ConnectCredentials) {
      if (
        input.kind !== "api-key" ||
        typeof input.apiKey !== "string" ||
        !input.apiKey.trim() ||
        input.baseURL ||
        input.headers
      ) {
        return fail(
          "invalid-state",
          "Provide a Gemini API key without endpoint or header overrides.",
        );
      }
      return ok({
        provider,
        authenticatedAt: new Date().toISOString(),
        credentials: { apiKey: input.apiKey },
      });
    },
    async checkAuth(state, context, options) {
      if (
        state.provider !== provider ||
        typeof state.credentials.apiKey !== "string" ||
        !state.credentials.apiKey.trim()
      ) {
        return fail("auth-required", "Gemini API key is missing.");
      }
      if (options?.validate === false) return ok(state);
      const result = await discover(state, context);
      return result.ok ? ok(state) : result;
    },
    async getAccount(state) {
      return ok({
        id: null,
        email: null,
        plan: null,
        isFree: null,
        lastAuthenticatedAt: state.authenticatedAt,
      });
    },
    async getQuota() {
      return ok({ supported: false, checkedAt: new Date().toISOString(), windows: [] });
    },
    listModels: discover,
    execute(request, state, context) {
      const send = async (body: Record<string, unknown>, signal: AbortSignal, action?: "count") => {
        const model = String(body.model);
        const { model: _, stream: streamValue, ...payload } = body;
        const stream = streamValue === true;
        const endpoint =
          interactions && action !== "count"
            ? "interactions"
            : `models/${encodeURIComponent(model)}:${action === "count" ? "countTokens" : stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
        return context.fetch(`https://generativelanguage.googleapis.com/v1beta/${endpoint}`, {
          method: "POST",
          headers: {
            "x-goog-api-key": String(state.credentials.apiKey),
            "content-type": "application/json",
            ...(interactions ? { "Api-Revision": "2026-05-20" } : {}),
          },
          body: JSON.stringify(
            action === "count" ? geminiCountBody(model, payload) : interactions ? body : payload,
          ),
          signal,
        });
      };
      return interactions && !new URL(request.url).pathname.endsWith("count_tokens")
        ? executeInteractions(request, send)
        : executeGemini(request, send);
    },
  };
};
async function discover(state: CredentialState, context: ProviderContext) {
  try {
    const models: Model[] = [];
    let pageToken = "";
    const seen = new Set<string>();
    do {
      const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }
      const response = await context.fetch(url, {
        headers: { "x-goog-api-key": String(state.credentials.apiKey) },
        signal: context.signal,
      });
      if (!response.ok) {
        return fail(
          response.status === 401 || response.status === 403
            ? "auth-required"
            : response.status === 429
              ? "rate-limited"
              : "provider-error",
          `Gemini model discovery failed (${response.status}).`,
          response.status >= 500 || response.status === 429,
        );
      }
      const body = (await response.json()) as {
        models?: { name?: unknown; supportedGenerationMethods?: string[] }[];
        nextPageToken?: unknown;
      };
      if (!Array.isArray(body.models)) {
        return fail("provider-error", "Gemini returned an invalid model list.");
      }
      for (const model of body.models) {
        if (
          typeof model.name === "string" &&
          model.supportedGenerationMethods?.includes("generateContent")
        ) {
          models.push({
            id: model.name.replace(/^models\//, ""),
            object: "model",
            created: 0,
            owned_by: "google",
          });
        }
      }
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
      if (pageToken && seen.has(pageToken)) {
        return fail("provider-error", "Gemini returned a repeated model page.");
      }
      seen.add(pageToken);
    } while (pageToken);
    return ok(models);
  } catch {
    return fail(
      context.signal.aborted ? "cancelled" : "network-error",
      "Gemini model discovery could not complete.",
      true,
    );
  }
}
export const gemini = makeGemini(false);
export const geminiInteractions = makeGemini(true);

export const createGeminiProvider = (id: "gemini" | "gemini-interactions") =>
  makeGemini(id === "gemini-interactions");
