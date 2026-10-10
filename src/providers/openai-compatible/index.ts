import { estimateTokens } from "../../protocols/tokens.js";
import { fail, ok } from "../../result.js";
import type { Model, Result } from "../../types.js";
import type { CredentialState, ProviderAdapter, ProviderContext } from "../contract.js";

function baseURL(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) {
      return;
    }
    const loopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      return;
    }
    return url.href.replace(/\/$/, "");
  } catch {
    return;
  }
}

function valid(state: CredentialState): boolean {
  return (
    typeof state.credentials.apiKey === "string" &&
    state.credentials.apiKey.trim().length > 0 &&
    !!baseURL(state.credentials.baseURL)
  );
}

export function createProvider(): ProviderAdapter {
  const execute: ProviderAdapter["execute"] = async (request, state, context) => {
    if (
      ["/v1/chat/completions/count_tokens", "/v1/messages/count_tokens"].includes(
        new URL(request.url).pathname,
      )
    )
      return estimateTokens(request);
    if (!valid(state)) {
      return Response.json(
        { error: { message: "Invalid upstream credentials", type: "authentication_error" } },
        { status: 401 },
      );
    }
    const source = new URL(request.url);
    const path = source.pathname.replace(/^\/v1(?=\/|$)/, "");
    const target = `${baseURL(state.credentials.baseURL)}${path}${source.search}`;
    const headers = new Headers(request.headers);
    if (
      state.credentials.headers &&
      typeof state.credentials.headers === "object" &&
      !Array.isArray(state.credentials.headers)
    ) {
      for (const [key, value] of Object.entries(state.credentials.headers)) {
        if (typeof value === "string") {
          headers.set(key, value);
        }
      }
    }
    headers.delete("host");
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${state.credentials.apiKey}`);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return context.fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      signal: context.signal,
      redirect: "manual",
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
  };
  const listModels = async (
    state: CredentialState,
    context: ProviderContext,
  ): Promise<Result<readonly Model[]>> => {
    try {
      const response = await execute(new Request("https://sdk.invalid/v1/models"), state, context);
      if (!response.ok) {
        return fail(
          response.status === 401 || response.status === 403
            ? "auth-required"
            : response.status === 429
              ? "rate-limited"
              : "provider-error",
          `Model discovery failed (${response.status})`,
          response.status === 429 || response.status >= 500,
        );
      }
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
        return fail("provider-error", "Invalid model-list response");
      }
      const models = body.data as unknown[];
      if (
        !models.every(
          (model) =>
            !!model &&
            typeof model === "object" &&
            "id" in model &&
            typeof model.id === "string" &&
            "created" in model &&
            typeof model.created === "number" &&
            "object" in model &&
            model.object === "model" &&
            "owned_by" in model &&
            typeof model.owned_by === "string",
        )
      ) {
        return fail("provider-error", "Invalid model metadata");
      }
      return ok(models as Model[]);
    } catch {
      return fail(
        context.signal.aborted ? "cancelled" : "network-error",
        "Model discovery could not complete",
        !context.signal.aborted,
      );
    }
  };
  return {
    descriptor: {
      id: "openai-compatibility",
      name: "OpenAI-compatible upstream",
      authMethods: ["api-key"],
      endpoints: [
        "models",
        "chat.completions",
        "responses",
        "embeddings",
        "images",
        "audio",
        "count_tokens",
      ],
      quota: false,
      modelDiscovery: "live",
    },
    async beginAuth() {
      return fail("unsupported", "This provider uses API-key connection");
    },
    async connect(input) {
      if (input.kind !== "api-key" || !input.apiKey.trim() || !baseURL(input.baseURL)) {
        return fail(
          "invalid-state",
          "Provide an API key and an HTTPS upstream baseURL (HTTP is allowed for loopback)",
        );
      }
      try {
        const headers = input.headers ? Object.fromEntries(new Headers(input.headers)) : {};
        return ok({
          provider: "openai-compatibility",
          authenticatedAt: new Date().toISOString(),
          credentials: { apiKey: input.apiKey, baseURL: baseURL(input.baseURL)!, headers },
        });
      } catch {
        return fail("invalid-state", "Invalid upstream headers");
      }
    },
    async checkAuth(state, context, options) {
      if (!valid(state)) {
        return fail("auth-required", "Invalid upstream credentials");
      }
      if (options?.validate === false) {
        return ok(state);
      }
      const models = await listModels(state, context);
      return models.ok ? ok(state) : models;
    },
    async getAccount() {
      return ok(null);
    },
    async getQuota() {
      return ok({ supported: false, checkedAt: new Date().toISOString(), windows: [] });
    },
    listModels,
    execute,
  };
}
