import { executeImages } from "./images.js";
import { createPKCE, createOAuthSession } from "../../auth/oauth.js";
import { createDeviceSession } from "../../auth/device.js";
import { executeChat, normalizeResponsesResponse } from "../../protocols/responses.js";
import type { ProviderAdapter, CredentialState, ProviderContext, JsonValue } from "../contract.js";
import type { Result, QuotaWindow, Model } from "../../types.js";
import { ok, fail } from "../../result.js";
import { protocolError } from "../../protocols/openai.js";

const clientID = "app_EMoamEEZ73f0CkXaXp7hrann";
const redirect = "http://localhost:1455/auth/callback";
const base = "https://chatgpt.com/backend-api/codex";
const tokenURL = "https://auth.openai.com/oauth/token";
const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
function claims(token: unknown): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1]!, "base64url").toString());
  } catch {
    return {};
  }
}
function endpoint(state: CredentialState): string | null {
  try {
    const url = new URL(String(state.credentials.baseURL ?? base));
    if (url.username || url.password || url.search || url.hash) {
      return null;
    }
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ) {
      return null;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
function headers(state: CredentialState, caller?: Headers): Headers {
  const h = new Headers({
    Authorization: `Bearer ${state.credentials.access_token ?? state.credentials.apiKey}`,
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.159.0",
    Accept: "application/json",
  });
  for (const name of [
    "x-codex-beta-features",
    "version",
    "x-codex-turn-metadata",
    "x-codex-turn-state",
    "x-client-request-id",
    "x-request-id",
    "x-codex-window-id",
    "thread-id",
    "session-id",
    "x-openai-internal-codex-responses-lite",
    "originator",
  ]) {
    const value = caller?.get(name);
    if (value) {
      h.set(name, value);
    }
  }
  const account = str(
    claims(state.credentials.id_token)["https://api.openai.com/auth"]?.chatgpt_account_id,
  );
  if (account) {
    h.set("ChatGPT-Account-ID", account);
  }
  return h;
}
function network<T>(context: ProviderContext): Result<T> {
  return context.signal.aborted
    ? fail("cancelled", "Codex operation cancelled")
    : fail("network-error", "Could not reach Codex", true);
}
async function token(
  form: Record<string, string>,
  context: ProviderContext,
  previous?: CredentialState,
): Promise<Result<CredentialState>> {
  try {
    const response = await context.fetch(tokenURL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: clientID, ...form }),
      signal: context.signal,
    });
    if (!response.ok) {
      return fail(
        response.status === 400 || response.status === 401 ? "auth-required" : "provider-error",
        `Codex token exchange failed (${response.status})`,
        response.status >= 500,
      );
    }
    const data = (await response.json()) as Record<string, unknown>;
    if (!str(data.access_token) || typeof data.expires_in !== "number" || data.expires_in <= 0) {
      return fail("provider-error", "Codex returned an invalid token response");
    }
    const credentials = {
      ...previous?.credentials,
      access_token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    } as Record<string, JsonValue>;
    for (const key of ["refresh_token", "id_token"]) {
      if (str(data[key])) {
        credentials[key] = data[key] as string;
      }
    }
    return ok({
      provider: "codex",
      authenticatedAt: previous?.authenticatedAt ?? new Date().toISOString(),
      credentials,
    });
  } catch {
    return network(context);
  }
}
async function read(
  url: string,
  state: CredentialState,
  context: ProviderContext,
): Promise<Result<Record<string, any>>> {
  try {
    const response = await context.fetch(url, { headers: headers(state), signal: context.signal });
    if (!response.ok) {
      return fail(
        response.status === 401 || response.status === 403
          ? "auth-required"
          : response.status === 429
            ? "rate-limited"
            : "provider-error",
        `Codex request failed (${response.status})`,
        response.status === 429 || response.status >= 500,
      );
    }
    return ok(await response.json());
  } catch {
    return network(context);
  }
}
export const codex: ProviderAdapter = {
  descriptor: {
    id: "codex",
    name: "Codex",
    authMethods: ["callback", "device", "api-key"],
    endpoints: ["models", "responses", "chat.completions", "images"],
    quota: true,
    modelDiscovery: "live",
  },
  async beginAuth(context, options) {
    if (options?.method === "device") {
      try {
        const response = await context.fetch(
          "https://auth.openai.com/api/accounts/deviceauth/usercode",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: clientID }),
            signal: context.signal,
          },
        );
        if (!response.ok) {
          return fail("provider-error", `Codex device login failed (${response.status})`);
        }
        const data = (await response.json()) as Record<string, any>;
        const userCode = str(data.user_code) ?? str(data.usercode);
        if (!userCode || !str(data.device_auth_id)) {
          return fail("provider-error", "Codex returned invalid device credentials");
        }
        return ok(
          createDeviceSession<CredentialState>({
            url: "https://auth.openai.com/codex/device",
            userCode,
            expiresInSeconds: 900,
            intervalSeconds: Math.max(Number(data.interval) || 5, 1),
            signal: context.signal,
            async poll(signal) {
              const local = { ...context, signal };
              const response = await context.fetch(
                "https://auth.openai.com/api/accounts/deviceauth/token",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    device_auth_id: data.device_auth_id,
                    user_code: userCode,
                  }),
                  signal,
                },
              );
              if ([403, 404].includes(response.status)) {
                return { pending: true };
              }
              if (!response.ok) {
                return fail(
                  "provider-error",
                  `Codex device polling failed (${response.status})`,
                  response.status >= 500,
                );
              }
              const code = (await response.json()) as Record<string, any>;
              if (!str(code.authorization_code) || !str(code.code_verifier)) {
                return fail("provider-error", "Codex returned invalid device authorization");
              }
              return token(
                {
                  grant_type: "authorization_code",
                  code: code.authorization_code,
                  code_verifier: code.code_verifier,
                  redirect_uri: "https://auth.openai.com/deviceauth/callback",
                },
                local,
              );
            },
          }),
        );
      } catch {
        return network(context);
      }
    }
    const { verifier, state, challenge } = createPKCE();
    const url = new URL("https://auth.openai.com/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: clientID,
      response_type: "code",
      redirect_uri: redirect,
      scope: "openid email profile offline_access",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "login",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    }).toString();
    return ok(
      createOAuthSession({
        url: url.toString(),
        redirectURI: redirect,
        state,
        expiresInSeconds: 300,
        signal: context.signal,
        exchange: (code, signal) =>
          token(
            {
              grant_type: "authorization_code",
              code,
              code_verifier: verifier,
              redirect_uri: redirect,
            },
            { ...context, signal },
          ),
      }),
    );
  },
  async connect(input) {
    if (input.kind !== "api-key") {
      return fail("unsupported", "Codex supports API keys or OAuth");
    }
    if (!input.apiKey.trim()) {
      return fail("auth-required", "An API key is required");
    }
    const state: CredentialState = {
      provider: "codex",
      authenticatedAt: new Date().toISOString(),
      credentials: { apiKey: input.apiKey, baseURL: input.baseURL ?? base },
    };
    const url = endpoint(state);
    if (!url) {
      return fail(
        "invalid-state",
        "Codex endpoint must use HTTPS or loopback HTTP without embedded credentials, query, or fragment",
      );
    }
    state.credentials.baseURL = url;
    return ok(state);
  },
  async checkAuth(state, context, options) {
    const url = endpoint(state);
    if (!url) {
      return fail("invalid-state", "Invalid Codex endpoint");
    }
    if (str(state.credentials.apiKey)) {
      if (options?.validate === false) {
        return ok(state);
      }
      const result = await read(`${url}/models?client_version=0.159.0`, state, context);
      return result.ok ? ok(state) : result;
    }
    if (!str(state.credentials.access_token)) {
      return fail("auth-required", "Codex login is required");
    }
    let current = state;
    if (
      options?.forceRefresh ||
      typeof state.credentials.expiresAt !== "number" ||
      state.credentials.expiresAt <= Date.now() + 30_000
    ) {
      if (!str(state.credentials.refresh_token)) {
        return fail("auth-required", "Codex login has expired");
      }
      const refreshed = await token(
        {
          grant_type: "refresh_token",
          refresh_token: String(state.credentials.refresh_token),
          scope: "openid profile email",
        },
        context,
        state,
      );
      if (!refreshed.ok) {
        return refreshed;
      }
      current = refreshed.value;
    }
    if (options?.validate) {
      const result = await read(`${url}/models?client_version=0.159.0`, current, context);
      if (!result.ok) {
        return result;
      }
    }
    return ok(current);
  },
  async getAccount(state) {
    const jwt = claims(state.credentials.id_token);
    const auth = jwt["https://api.openai.com/auth"] ?? {};
    const plan = str(auth.chatgpt_plan_type);
    return ok({
      id: str(auth.chatgpt_account_id),
      email: str(jwt.email),
      plan,
      isFree: plan ? plan === "free" : null,
      lastAuthenticatedAt: state.authenticatedAt,
    });
  },
  async getQuota(state, context) {
    if (state.credentials.apiKey) {
      return ok({ supported: false, checkedAt: new Date().toISOString(), windows: [] });
    }
    const result = await read("https://chatgpt.com/backend-api/wham/usage", state, context);
    if (!result.ok) {
      return result;
    }
    const windows: QuotaWindow[] = [];
    const add = (rate: any, model: string | null = null) => {
      for (const name of ["primary_window", "secondary_window"]) {
        const w = rate?.[name];
        if (!w || typeof w !== "object") {
          continue;
        }
        const duration = typeof w.limit_window_seconds === "number" ? w.limit_window_seconds : null;
        const reset =
          typeof w.reset_at === "number"
            ? w.reset_at * 1000
            : typeof w.reset_after_seconds === "number"
              ? Date.now() + w.reset_after_seconds * 1000
              : null;
        windows.push({
          name: duration === 604800 ? "weekly" : duration === 18000 ? "5-hour" : name,
          model,
          durationSeconds: duration,
          remainingPercent:
            typeof w.used_percent === "number"
              ? Math.max(0, Math.min(100, 100 - w.used_percent))
              : null,
          remaining: null,
          limit: null,
          unit: null,
          resetsAt:
            reset === null || !Number.isFinite(reset) ? null : new Date(reset).toISOString(),
        });
      }
    };
    add(result.value.rate_limit);
    add(result.value.code_review_rate_limit, "code-review");
    if (Array.isArray(result.value.additional_rate_limits)) {
      for (const limit of result.value.additional_rate_limits) {
        add(limit.rate_limit, str(limit.limit_name));
      }
    }
    return ok({ supported: true, checkedAt: new Date().toISOString(), windows });
  },
  async listModels(state, context) {
    const url = endpoint(state);
    if (!url) {
      return fail("invalid-state", "Invalid Codex endpoint");
    }
    const result = await read(`${url}/models?client_version=0.159.0`, state, context);
    if (!result.ok) {
      return result;
    }
    const models = result.value.models ?? result.value.data;
    if (!Array.isArray(models)) {
      return fail("provider-error", "Codex returned an invalid model catalog");
    }
    return ok(
      models.flatMap((model: any): Model[] => {
        const id = str(model.slug) ?? str(model.id);
        return id
          ? [
              {
                id,
                object: "model",
                created: typeof model.created === "number" ? model.created : 0,
                owned_by: "codex",
              },
            ]
          : [];
      }),
    );
  },
  async execute(request, state, context) {
    const url = endpoint(state);
    if (!url) {
      return protocolError("Invalid Codex endpoint");
    }
    const path = new URL(request.url).pathname.replace(/^\/v1/, "");
    if (request.method === "POST" && ["/images/generations", "/images/edits"].includes(path)) {
      return executeImages(request, url, headers(state, request.headers), context);
    }
    if (path === "/chat/completions") {
      return executeChat(request, async (body, signal) =>
        codex.execute(
          new Request("https://internal/v1/responses", {
            method: "POST",
            body: JSON.stringify(body),
            signal,
            headers: request.headers,
          }),
          state,
          context,
        ),
      );
    }
    if (request.method !== "POST" || !["/responses", "/responses/compact"].includes(path)) {
      return protocolError("Codex supports Responses and Responses compact", 404);
    }
    const body = (await request.json()) as Record<string, any>;
    if (path === "/responses/compact" && body.stream) {
      return protocolError("Codex compact does not support streaming");
    }
    body.instructions ??= "";
    if (typeof body.input === "string") {
      body.input = [
        { type: "message", role: "user", content: [{ type: "input_text", text: body.input }] },
      ];
    }
    if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (item.role === "system") {
          item.role = "developer";
        }
        if (
          item.type === "function_call" &&
          typeof item.arguments === "string" &&
          !item.arguments.trim()
        ) {
          item.arguments = "{}";
        }
      }
    }
    const stream = body.stream === true;
    if (path === "/responses") {
      body.store = false;
      body.stream = true;
      body.parallel_tool_calls ??= true;
      body.include = [
        ...new Set([
          ...(Array.isArray(body.include) ? body.include : []),
          "reasoning.encrypted_content",
        ]),
      ];
      for (const field of [
        "max_output_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "previous_response_id",
        "generate",
        "truncation",
        "prompt_cache_options",
        "prompt_cache_retention",
        "safety_identifier",
        "stream_options",
        "user",
      ]) {
        delete body[field];
      }
      if (body.service_tier === "fast") {
        body.service_tier = "priority";
      }
      if (!["priority", "ultrafast"].includes(body.service_tier)) {
        delete body.service_tier;
      }
    }
    const h = headers(state, request.headers);
    h.set("Content-Type", "application/json");
    h.set("Accept", path === "/responses" ? "text/event-stream" : "application/json");
    const response = await context.fetch(`${url}${path}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.any([request.signal, context.signal]),
    });
    if (!response.ok || stream || path !== "/responses") {
      return response;
    }
    return normalizeResponsesResponse(
      response,
      AbortSignal.any([request.signal, context.signal]),
      true,
    );
  },
};
export const createProvider = (): ProviderAdapter => codex;
