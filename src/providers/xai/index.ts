import { executeVideo } from "./videos.js";
import { createDeviceSession } from "../../auth/device.js";
import { fail, ok } from "../../result.js";
import type { Result } from "../../types.js";
import type { CredentialState, ProviderAdapter, ProviderContext } from "../contract.js";
import { executeOpenAI, protocolError } from "../../protocols/openai.js";
import { executeChat, normalizeResponsesResponse } from "../../protocols/responses.js";

const clientID = "b1a00492-073a-47ea-816f-4c329264a828";
const scope = "openid profile email offline_access grok-cli:access api:access";
const models = [
  "grok-4.7",
  "grok-4.7-build-fast",
  "grok-4.6",
  "grok-build-0.1",
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-4.20-multi-agent-0309",
  "grok-3-mini",
  "grok-3-mini-fast",
  "grok-composer-2.5-fast",
  "grok-imagine-video",
  "grok-imagine-video-1.5",
  "grok-imagine-video-1.5-preview",
];

function trustedEndpoint(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid xAI endpoint");
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"))
  ) {
    throw new Error("Untrusted xAI endpoint");
  }
  return url.href;
}
async function discovery(context: ProviderContext) {
  const response = await context.fetch("https://auth.x.ai/.well-known/openid-configuration", {
    signal: context.signal,
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error("xAI discovery failed");
  }
  const data = (await response.json()) as Record<string, unknown>;
  return {
    device: trustedEndpoint(data.device_authorization_endpoint),
    token: trustedEndpoint(data.token_endpoint),
  };
}
async function post(url: string, body: Record<string, string>, context: ProviderContext) {
  return context.fetch(trustedEndpoint(url), {
    method: "POST",
    body: new URLSearchParams(body),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    signal: context.signal,
    redirect: "error",
  });
}
function reportedIdentity(token: unknown): { email?: string; subject?: string } {
  if (typeof token !== "string") {
    return {};
  }
  try {
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    // Provider-reported metadata only: these claims never authorize requests.
    return {
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      ...(typeof claims.sub === "string" ? { subject: claims.sub } : {}),
    };
  } catch {
    return {};
  }
}
function credentials(
  data: Record<string, unknown>,
  previous?: CredentialState,
): Result<CredentialState> {
  if (
    typeof data.access_token !== "string" ||
    !data.access_token.trim() ||
    (data.token_type !== undefined && String(data.token_type).toLowerCase() !== "bearer") ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  ) {
    return fail("provider-error", "xAI returned invalid token credentials.");
  }
  return ok({
    provider: "xai",
    authenticatedAt: previous?.authenticatedAt ?? new Date().toISOString(),
    credentials: {
      ...previous?.credentials,
      accessToken: data.access_token,
      ...(typeof data.id_token === "string" && data.id_token
        ? { idToken: data.id_token, ...reportedIdentity(data.id_token) }
        : {}),
      refreshToken:
        typeof data.refresh_token === "string" && data.refresh_token
          ? data.refresh_token
          : (previous?.credentials.refreshToken ?? null),
      expiresAt: Date.now() + data.expires_in * 1000,
    },
  });
}
export const xai: ProviderAdapter = {
  descriptor: {
    id: "xai",
    name: "xAI",
    authMethods: ["device", "api-key"],
    endpoints: ["models", "chat.completions", "responses", "images", "videos"],
    quota: false,
    modelDiscovery: "catalog",
  },
  async beginAuth(context, options) {
    if (options?.method === "callback") {
      return fail("unsupported", "xAI uses device authorization.");
    }
    try {
      const endpoints = await discovery(context);
      const response = await post(endpoints.device, { client_id: clientID, scope }, context);
      const data = (await response.json()) as Record<string, unknown>;
      if (
        !response.ok ||
        typeof data.device_code !== "string" ||
        !data.device_code ||
        typeof data.user_code !== "string" ||
        typeof data.expires_in !== "number" ||
        data.expires_in <= 0
      ) {
        return fail("provider-error", "xAI returned an invalid device authorization.");
      }
      const url = trustedEndpoint(data.verification_uri_complete ?? data.verification_uri);
      const deviceCode = data.device_code;
      return ok(
        createDeviceSession({
          url,
          userCode: data.user_code,
          expiresInSeconds: Math.min(data.expires_in, 1800),
          intervalSeconds: typeof data.interval === "number" ? Math.max(5, data.interval) : 5,
          signal: context.signal,
          async poll(signal) {
            const response = await post(
              endpoints.token,
              {
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                client_id: clientID,
                device_code: deviceCode,
              },
              { ...context, signal },
            );
            const data = (await response.json()) as Record<string, unknown>;
            if (data.error === "authorization_pending") {
              return { pending: true };
            }
            if (data.error === "slow_down") {
              return { pending: true, slowDown: true };
            }
            if (!response.ok) {
              return fail(
                data.error === "expired_token" ? "auth-expired" : "auth-denied",
                "xAI authorization was not completed.",
              );
            }
            const result = credentials(data);
            if (result.ok) {
              result.value.credentials.tokenEndpoint = endpoints.token;
            }
            return result;
          },
        }),
      );
    } catch {
      return fail(
        context.signal.aborted ? "cancelled" : "provider-error",
        "Could not start xAI authorization.",
        true,
      );
    }
  },
  async connect(input) {
    if (input.kind !== "api-key" || !input.apiKey.trim()) {
      return fail("invalid-state", "A nonempty xAI API key is required.");
    }
    if (input.baseURL || input.headers) {
      return fail(
        "unsupported",
        "Use OpenAI-compatible setup for custom xAI endpoints or headers.",
      );
    }
    return ok({
      provider: "xai",
      authenticatedAt: new Date().toISOString(),
      credentials: { apiKey: input.apiKey },
    });
  },
  async checkAuth(state, context, options) {
    if (typeof state.credentials.apiKey === "string" && state.credentials.apiKey.trim()) {
      if (options?.validate === false) {
        return ok(state);
      }
      try {
        const response = await context.fetch("https://api.x.ai/v1/models", {
          headers: { Authorization: `Bearer ${state.credentials.apiKey}` },
          signal: context.signal,
          redirect: "error",
        });
        if (response.status === 401 || response.status === 403) {
          return fail("auth-required", "xAI API key is invalid.");
        }
        if (!response.ok) {
          return fail(
            response.status === 429 ? "rate-limited" : "provider-error",
            "Could not validate xAI API key.",
            true,
          );
        }
        return ok(state);
      } catch {
        return fail("network-error", "Could not validate xAI credentials.", true);
      }
    }
    if (
      typeof state.credentials.accessToken !== "string" ||
      !state.credentials.accessToken.trim()
    ) {
      return fail("auth-required", "xAI login is required.");
    }
    if (
      !options?.forceRefresh &&
      typeof state.credentials.expiresAt === "number" &&
      state.credentials.expiresAt > Date.now() + 300_000
    ) {
      return ok(state);
    }
    if (typeof state.credentials.refreshToken !== "string" || !state.credentials.refreshToken) {
      return fail("auth-required", "xAI login has expired.");
    }
    try {
      const token = state.credentials.tokenEndpoint
        ? trustedEndpoint(state.credentials.tokenEndpoint)
        : (await discovery(context)).token;
      const response = await post(
        token,
        {
          grant_type: "refresh_token",
          client_id: clientID,
          refresh_token: state.credentials.refreshToken,
        },
        context,
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        const revoked =
          response.status === 401 || response.status === 403 || data?.error === "invalid_grant";
        return fail(
          response.status === 429 ? "rate-limited" : revoked ? "auth-required" : "provider-error",
          "Could not refresh xAI login.",
          response.status === 429 || response.status >= 500,
        );
      }
      return credentials((await response.json()) as Record<string, unknown>, state);
    } catch {
      return fail("network-error", "Could not refresh xAI login.", true);
    }
  },
  async getAccount(state) {
    return ok({
      id: typeof state.credentials.subject === "string" ? state.credentials.subject : null,
      email: typeof state.credentials.email === "string" ? state.credentials.email : null,
      plan: null,
      isFree: null,
      lastAuthenticatedAt: state.authenticatedAt,
    });
  },
  async getQuota() {
    return ok({ supported: false, checkedAt: new Date().toISOString(), windows: [] });
  },
  async listModels() {
    return ok(models.map((id) => ({ id, object: "model" as const, created: 0, owned_by: "xai" })));
  },
  async execute(request, state, context) {
    const path = new URL(request.url).pathname.replace(/^\/v1/, "");
    const apiKey = typeof state.credentials.apiKey === "string" ? state.credentials.apiKey : null;
    const token = apiKey ?? state.credentials.accessToken;
    if (typeof token !== "string" || !token) {
      return protocolError("xAI authentication required.", 401);
    }
    const base = apiKey ? "https://api.x.ai/v1" : "https://cli-chat-proxy.grok.com/v1";
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    });
    if (!apiKey) {
      headers.set("X-XAI-Token-Auth", "xai-grok-cli");
      headers.set("x-grok-client-version", "1.0.44");
      headers.set("x-grok-client-identifier", "grok-shell");
      headers.set("x-authenticateresponse", "authenticate-response");
      headers.set("User-Agent", "xai-grok-workspace/1.0.44");
    }
    if (path === "/videos" || path.startsWith("/videos/")) {
      return executeVideo(request, base, headers, context);
    }
    if (path === "/chat/completions" || path === "/responses") {
      return (path === "/chat/completions" ? executeChat : executeOpenAI)(
        request,
        async (body, signal) => {
          const response = await context.fetch(`${base}/responses`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.any([signal, context.signal]),
            redirect: "error",
          });
          return body.stream ? response : normalizeResponsesResponse(response, signal);
        },
      );
    }
    if (!["/images/generations", "/images/edits"].includes(path)) {
      return protocolError("Unsupported xAI endpoint.", 404);
    }
    headers.set("Content-Type", request.headers.get("Content-Type") ?? "application/json");
    return context.fetch(`${base}${path}`, {
      method: request.method,
      headers,
      body: await request.arrayBuffer(),
      signal: AbortSignal.any([request.signal, context.signal]),
      redirect: "error",
    });
  },
};

export function createProvider(): ProviderAdapter {
  return xai;
}
