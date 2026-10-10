import { ok, fail } from "../../result.js";
import type { Result } from "../../types.js";
import type { ProviderAdapter, CredentialState, ProviderContext, JsonValue } from "../contract.js";
import { executeAnthropic } from "../../protocols/anthropic.js";
import { createPKCE, createOAuthSession } from "../../auth/oauth.js";
import {
  quota,
  quotaJSON,
  record as quotaRecord,
  number,
  percent,
  timestamp,
  window,
} from "../quota.js";

const clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const redirectURI = "http://localhost:54545/callback";
const scope =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const tokenURL = "https://platform.claude.com/v1/oauth/token";
const profileURL = "https://api.anthropic.com/api/oauth/profile";
const controlHeaders = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "User-Agent": "axios/1.15.2",
};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

async function jsonRequest(
  url: string,
  init: RequestInit,
  context: ProviderContext,
  tokenRequest = false,
): Promise<Result<Record<string, unknown>>> {
  try {
    const response = await context.fetch(url, {
      ...init,
      signal: context.signal,
      redirect: "error",
    });
    if (!response.ok) {
      if (tokenRequest && response.status === 400) {
        const data: unknown = await response.json().catch(() => null);
        if (record(data).error === "invalid_grant") {
          return fail("auth-required", "Claude authorization has expired or been revoked.");
        }
      }
      return fail(
        response.status === 401 || response.status === 403
          ? "auth-required"
          : response.status === 429
            ? "rate-limited"
            : "provider-error",
        `Claude request failed (${response.status}).`,
        response.status === 429 || response.status >= 500,
      );
    }
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return fail("provider-error", "Claude returned an invalid response.");
    }
    return ok(data as Record<string, unknown>);
  } catch {
    return fail(
      context.signal.aborted ? "cancelled" : "network-error",
      context.signal.aborted ? "Claude request cancelled." : "Unable to contact Claude.",
      !context.signal.aborted,
    );
  }
}
async function tokenState(
  body: Record<string, unknown>,
  context: ProviderContext,
  previous?: CredentialState,
): Promise<Result<CredentialState>> {
  const result = await jsonRequest(
    tokenURL,
    { method: "POST", headers: controlHeaders, body: JSON.stringify(body) },
    context,
    true,
  );
  if (!result.ok) {
    return result;
  }
  const token = text(result.value.access_token);
  const expires = result.value.expires_in;
  if (!token || typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) {
    return fail("provider-error", "Claude returned invalid credentials.");
  }
  const account = record(result.value.account);
  const credentials: Record<string, JsonValue> = {
    ...previous?.credentials,
    accessToken: token,
    refreshToken: text(result.value.refresh_token) ?? text(previous?.credentials.refreshToken),
    expiresAt: new Date(Date.now() + expires * 1000).toISOString(),
    accountId: text(account.uuid) ?? text(previous?.credentials.accountId),
    email: text(account.email_address) ?? text(previous?.credentials.email),
  };
  return ok({
    provider: "claude",
    authenticatedAt: previous?.authenticatedAt ?? new Date().toISOString(),
    credentials,
  });
}

export const claude: ProviderAdapter = {
  descriptor: {
    id: "claude",
    name: "Claude",
    authMethods: ["callback", "api-key"],
    endpoints: [
      "models",
      "chat.completions",
      "responses",
      "count_tokens",
      "messages",
      "responses.compact",
    ],
    quota: true,
    modelDiscovery: "catalog",
  },
  async beginAuth(context, options) {
    if (options?.method === "device") {
      return fail("unsupported", "Claude supports callback login.");
    }
    const pkce = createPKCE();
    const url = new URL("https://claude.ai/oauth/authorize");
    url.search = new URLSearchParams({
      code: "true",
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectURI,
      scope,
      state: pkce.state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    }).toString();
    const session = createOAuthSession({
      url: url.toString(),
      redirectURI,
      state: pkce.state,
      signal: context.signal,
      exchange: (code, signal) =>
        tokenState(
          {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectURI,
            client_id: clientId,
            code_verifier: pkce.verifier,
            state: pkce.state,
          },
          { ...context, signal },
        ),
    });
    return ok({
      ...session,
      complete(callback: string) {
        // Claude also displays a code#state value for manual completion.
        if (!callback.includes("://") && callback.includes("#")) {
          const [code, state] = callback.split("#");
          const normalized = new URL(redirectURI);
          normalized.search = new URLSearchParams({ code, state }).toString();
          callback = normalized.toString();
        } else {
          try {
            const parsed = new URL(callback);
            const code = parsed.searchParams.get("code");
            if (code?.includes("#")) {
              const [cleanCode, fragmentState] = code.split("#");
              parsed.searchParams.set("code", cleanCode);
              parsed.searchParams.set("state", fragmentState);
              callback = parsed.toString();
            } else if (code && parsed.hash && !parsed.searchParams.has("state")) {
              parsed.searchParams.set("state", parsed.hash.slice(1));
              parsed.hash = "";
              callback = parsed.toString();
            }
          } catch {
            /* Shared helper returns invalid-callback. */
          }
        }
        return session.complete(callback);
      },
    });
  },
  async connect(input) {
    if (input.kind !== "api-key") {
      return fail("unsupported", "Claude requires an API key or callback login.");
    }
    if (!input.apiKey.trim()) {
      return fail("auth-required", "An API key is required.");
    }
    if (input.baseURL || input.headers || input.project || input.location) {
      return fail("unsupported", "Custom Claude endpoints or headers are not supported.");
    }
    return ok({
      provider: "claude",
      authenticatedAt: new Date().toISOString(),
      credentials: { apiKey: input.apiKey },
    });
  },
  async checkAuth(state, context, options) {
    if (text(state.credentials.apiKey)) {
      if (options?.validate === false) {
        return ok(state);
      }
      const checked = await jsonRequest(
        "https://api.anthropic.com/v1/models?limit=1",
        {
          headers: {
            "x-api-key": String(state.credentials.apiKey),
            "anthropic-version": "2023-06-01",
          },
        },
        context,
      );
      return checked.ok ? ok(state) : checked;
    }
    if (!text(state.credentials.accessToken)) {
      return fail("auth-required", "Claude login is required.");
    }
    const expiresAt = Date.parse(String(state.credentials.expiresAt));
    if (options?.forceRefresh || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) {
      if (!text(state.credentials.refreshToken)) {
        return fail("auth-required", "Claude login has expired.");
      }
      return tokenState(
        {
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: state.credentials.refreshToken,
          scope,
        },
        context,
        state,
      );
    }
    if (options?.validate === false) {
      return ok(state);
    }
    const profile = await jsonRequest(
      profileURL,
      {
        headers: {
          ...controlHeaders,
          Authorization: `Bearer ${state.credentials.accessToken}`,
          "Cache-Control": "no-cache",
        },
      },
      context,
    );
    if (!profile.ok) {
      return profile;
    }
    return ok(state);
  },
  async getAccount(state, context) {
    if (text(state.credentials.apiKey)) {
      return ok({
        id: null,
        email: null,
        plan: null,
        isFree: null,
        lastAuthenticatedAt: state.authenticatedAt,
      });
    }
    const result = await jsonRequest(
      profileURL,
      {
        headers: {
          ...controlHeaders,
          Authorization: `Bearer ${state.credentials.accessToken}`,
          "Cache-Control": "no-cache",
        },
      },
      context,
    );
    if (!result.ok) {
      return result;
    }
    const account = record(result.value.account);
    return ok({
      id: text(account.uuid),
      email: text(account.email),
      plan: null,
      isFree: null,
      lastAuthenticatedAt: state.authenticatedAt,
    });
  },
  async getQuota(state, context) {
    if (text(state.credentials.apiKey)) return quota([], false);
    const token = text(state.credentials.accessToken);
    if (!token) return fail("auth-required", "Claude login is required.");
    const result = await quotaJSON(context, "https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-cli/2.1.280 (external, cli)",
        "Content-Type": "application/json",
      },
    });
    if (!result.ok) return result;
    const windows = Object.entries(result.value).flatMap(([name, value]) => {
      const usage = quotaRecord(value),
        used = number(usage.utilization);
      if (used === null && !usage.resets_at) return [];
      return [
        window(name, {
          remainingPercent: percent(used === null ? null : 100 - used),
          resetsAt: timestamp(usage.resets_at),
          durationSeconds:
            name === "five_hour"
              ? 18000
              : name.startsWith("seven_day") || name === "iguana_necktie"
                ? 604800
                : null,
        }),
      ];
    });
    const extra = quotaRecord(result.value.extra_usage);
    if (extra.is_enabled === true) {
      const limit = number(extra.monthly_limit),
        used = number(extra.used_credits),
        utilization = number(extra.utilization);
      windows.push(
        window("extra-usage", {
          limit,
          remaining: limit !== null && used !== null ? Math.max(0, limit - used) : null,
          remainingPercent: percent(utilization === null ? null : 100 - utilization),
          unit: "usd-cents",
        }),
      );
    }
    return quota(windows);
  },
  async listModels() {
    return ok(models);
  },
  async execute(request, state, context) {
    return executeAnthropic(request, async (body, signal, action) => {
      const headers = new Headers({
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      });
      if (text(state.credentials.apiKey)) {
        headers.set("x-api-key", String(state.credentials.apiKey));
      } else {
        headers.set("Authorization", `Bearer ${state.credentials.accessToken}`);
        headers.set(
          "anthropic-beta",
          "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
        );
        headers.set("User-Agent", "claude-cli/2.1.280 (external, cli)");
        headers.set("x-app", "cli");
      }
      return context.fetch(
        `https://api.anthropic.com/v1/messages${action === "count" ? "/count_tokens" : ""}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, context.signal]),
          redirect: "error",
        },
      );
    });
  },
};

const models = [
  {
    id: "claude-haiku-4-5-20251001",
    object: "model",
    created: 1759276800,
    owned_by: "anthropic",
  },
  {
    id: "claude-sonnet-4-5-20250929",
    object: "model",
    created: 1759104000,
    owned_by: "anthropic",
  },
  {
    id: "claude-sonnet-4-6",
    object: "model",
    created: 1771372800,
    owned_by: "anthropic",
  },
  {
    id: "claude-opus-4-6",
    object: "model",
    created: 1770318000,
    owned_by: "anthropic",
  },
  {
    id: "claude-opus-4-7",
    object: "model",
    created: 1776297600,
    owned_by: "anthropic",
  },
  {
    id: "claude-opus-4-8",
    object: "model",
    created: 1779984000,
    owned_by: "anthropic",
  },
  {
    id: "claude-opus-5",
    object: "model",
    created: 1784038800,
    owned_by: "anthropic",
  },
  {
    id: "claude-sonnet-5",
    object: "model",
    created: 1782777600,
    owned_by: "anthropic",
  },
  {
    id: "claude-fable-5",
    object: "model",
    created: 1781049600,
    owned_by: "anthropic",
  },
  {
    id: "claude-fable-5-1",
    object: "model",
    created: 1788220800,
    owned_by: "anthropic",
  },
  {
    id: "claude-opus-5-5",
    object: "model",
    created: 1790035200,
    owned_by: "anthropic",
  },
  {
    id: "claude-sonnet-5-5",
    object: "model",
    created: 1790553600,
    owned_by: "anthropic",
  },
  {
    id: "claude-opus-4-5-20251101",
    object: "model",
    created: 1761955200,
    owned_by: "anthropic",
  },
  {
    id: "claude-opus-4-1-20250805",
    object: "model",
    created: 1722945600,
    owned_by: "anthropic",
  },
  {
    id: "claude-opus-4-20250514",
    object: "model",
    created: 1715644800,
    owned_by: "anthropic",
  },
  {
    id: "claude-sonnet-4-20250514",
    object: "model",
    created: 1715644800,
    owned_by: "anthropic",
  },
  {
    id: "claude-3-7-sonnet-20250219",
    object: "model",
    created: 1708300800,
    owned_by: "anthropic",
  },
  {
    id: "claude-3-5-haiku-20241022",
    object: "model",
    created: 1729555200,
    owned_by: "anthropic",
  },
] as const;

export const createProvider = (): ProviderAdapter => claude;
