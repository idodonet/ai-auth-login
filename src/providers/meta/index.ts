import { createDeviceSession } from "../../auth/device.js";
import { ok, fail } from "../../result.js";
import type { CredentialState, ProviderAdapter, ProviderContext } from "../contract.js";
import type { Result } from "../../types.js";
import { executeChat } from "../../protocols/responses.js";
import { executeOpenAI, protocolError } from "../../protocols/openai.js";

const baseURL = "https://api.meta.ai/v1";
const clientID = "1031625952748946";
const userAgent = "muse-code/1.0.2";
const models = [
  "muse-spark-1.3",
  "muse-spark-1.3-contributor",
  "muse-spark-1.2",
  "muse-spark-1.2-contributor",
  "muse-spark-1.1",
].map((id) => ({ id, object: "model" as const, created: 0, owned_by: "meta" }));
function trustedURL(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return baseURL;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "api.meta.ai" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname.replace(/\/$/, "") === "/v1"
      ? baseURL
      : null;
  } catch {
    return null;
  }
}
async function mint(
  token: string,
  state: CredentialState,
  context: ProviderContext,
): Promise<Result<CredentialState>> {
  const response = await context.fetch("https://api.meta.ai/muse-code/key", {
    method: "POST",
    signal: context.signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": userAgent,
    },
    body: JSON.stringify({ dca_token: token }),
  });
  if (!response.ok) {
    return fail(
      response.status === 401 || response.status === 403 ? "auth-required" : "provider-error",
      "Meta could not mint an API key.",
      response.status >= 500,
    );
  }
  const body = (await response.json()) as Record<string, unknown>;
  const url = trustedURL(body.base_url);
  if (typeof body.api_key !== "string" || !body.api_key.trim() || !url) {
    return fail("provider-error", "Meta returned invalid API credentials.");
  }
  return ok({
    ...state,
    credentials: {
      apiKey: body.api_key,
      baseURL: url,
      dcaToken: token,
      email: typeof body.user_email === "string" ? body.user_email : null,
      plan: typeof body.subs_tier_name === "string" ? body.subs_tier_name : null,
    },
  });
}
export const meta: ProviderAdapter = {
  descriptor: {
    id: "meta",
    name: "Meta",
    authMethods: ["device", "api-key"],
    endpoints: ["models", "responses", "chat.completions"],
    quota: false,
    modelDiscovery: "catalog",
  },
  async beginAuth(context, options) {
    if (options?.method === "callback") {
      return fail("unsupported", "Meta uses device authorization.");
    }
    const response = await context.fetch("https://auth.meta.com/oidc/device/authorization/", {
      method: "POST",
      signal: context.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent },
      body: new URLSearchParams({ client_id: clientID }),
    });
    if (!response.ok) {
      return fail("provider-error", "Meta device authorization failed.", response.status >= 500);
    }
    const device = (await response.json()) as Record<string, unknown>;
    if (typeof device.device_code !== "string" || typeof device.verification_uri !== "string") {
      return fail("provider-error", "Meta returned invalid device authorization.");
    }
    const code = device.device_code;
    return ok(
      createDeviceSession({
        url:
          typeof device.verification_uri_complete === "string"
            ? device.verification_uri_complete
            : device.verification_uri,
        userCode: typeof device.user_code === "string" ? device.user_code : null,
        expiresInSeconds: Math.min(
          typeof device.expires_in === "number" ? device.expires_in : 900,
          900,
        ),
        intervalSeconds: typeof device.interval === "number" ? device.interval : 5,
        signal: context.signal,
        async poll(signal) {
          const response = await context.fetch("https://auth.meta.com/oidc/device/token/", {
            method: "POST",
            signal,
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": userAgent,
            },
            body: new URLSearchParams({
              client_id: clientID,
              device_code: code,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
          });
          const body = (await response.json()) as Record<string, unknown>;
          if (body.error === "authorization_pending") {
            return { pending: true };
          }
          if (body.error === "slow_down") {
            return { pending: true, slowDown: true };
          }
          if (!response.ok || typeof body.access_token !== "string") {
            return fail(
              body.error === "expired_token" ? "auth-expired" : "auth-denied",
              "Meta device authorization was not completed.",
            );
          }
          return mint(
            body.access_token,
            { provider: "meta", authenticatedAt: new Date().toISOString(), credentials: {} },
            { ...context, signal },
          );
        },
      }),
    );
  },
  async connect(input) {
    if (input.kind !== "api-key") {
      return fail("unsupported", "Meta requires an API key or device login.");
    }
    const url = trustedURL(input.baseURL);
    if (!input.apiKey.trim() || !url) {
      return fail("invalid-state", "A Meta API key and trusted Meta API URL are required.");
    }
    return ok({
      provider: "meta",
      authenticatedAt: new Date().toISOString(),
      credentials: { apiKey: input.apiKey, baseURL: url },
    });
  },
  async checkAuth(state, context, options) {
    const url = trustedURL(state.credentials.baseURL);
    if (!url || typeof state.credentials.apiKey !== "string" || !state.credentials.apiKey) {
      return fail("auth-required", "Meta credentials are invalid.");
    }
    // Meta publishes a static model catalog and no credential-validation endpoint.
    // DCA remint is the available validation/refresh operation for device credentials.
    if (
      typeof state.credentials.dcaToken === "string" &&
      (options?.forceRefresh || options?.validate !== false)
    ) {
      return mint(state.credentials.dcaToken, state, context);
    }
    return ok(state);
  },
  async getAccount(state) {
    return ok({
      id: null,
      email: typeof state.credentials.email === "string" ? state.credentials.email : null,
      plan: typeof state.credentials.plan === "string" ? state.credentials.plan : null,
      isFree: null,
      lastAuthenticatedAt: state.authenticatedAt,
    });
  },
  async getQuota() {
    return ok({ supported: false, checkedAt: new Date().toISOString(), windows: [] });
  },
  async listModels() {
    return ok(models);
  },
  async execute(request, state, context) {
    const url = trustedURL(state.credentials.baseURL);
    if (!url || typeof state.credentials.apiKey !== "string") {
      return protocolError("Meta credentials are invalid.", 401);
    }
    const native = (body: Record<string, unknown>, signal: AbortSignal) =>
      context.fetch(`${url}/responses`, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${state.credentials.apiKey}`,
          "Content-Type": "application/json",
          "X-Client-Id": "tbh:tui",
          "User-Agent":
            "muse-build/1.3.0 (interactive; macos-aarch64; build ac7280f2aca67769d1455a8847bb502b617d50f6)",
        },
        body: JSON.stringify(body),
      });
    const path = new URL(request.url).pathname;
    if (path === "/v1/chat/completions") {
      return executeChat(request, native);
    }
    if (path === "/v1/responses") {
      return executeOpenAI(request, native);
    }
    return protocolError("Meta supports Responses and Chat Completions only.", 404);
  },
};

export const createProvider = (): ProviderAdapter => meta;
