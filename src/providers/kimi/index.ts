import { executeAnthropic } from "../../protocols/anthropic.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createDeviceSession } from "../../auth/device.js";
import { ok, fail } from "../../result.js";
import { protocolError } from "../../protocols/openai.js";
import type { CredentialState, ProviderAdapter, ProviderContext } from "../contract.js";
import type { Result } from "../../types.js";
import { quota, quotaJSON, record, number, percent, timestamp, window } from "../quota.js";

// CLIProxyAPI e2bff010: internal/auth/kimi and internal/registry/models/models.json.
const clientID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const modelIDs = [
  "kimi-k2",
  "kimi-k2-thinking",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.8",
  "kimi-k2.8-code",
  "kimi-k3",
  "kimi-k3-256k",
];
const created = [
  1752192000, 1762387200, 1769472000, 1776729600, 1780396800, 1780396800, 1789115500, 1789115500,
  1784073600, 1785110400,
];
function headers(deviceID: string): Record<string, string> {
  return {
    "X-Msh-Platform": "CLIProxyAPI",
    "X-Msh-Version": "0.1.0",
    "X-Msh-Device-Name": hostname(),
    "X-Msh-Device-Model": `${process.platform}/${process.arch}`,
    "X-Msh-Device-Id": deviceID,
  };
}
function nativeModel(model: string): string {
  const suffix = model.match(/\([^()]+\)$/)?.[0] ?? "";
  const base = model
    .trim()
    .toLowerCase()
    .replace(/\([^()]+\)$/, "")
    .replace(/\[1m\]$/, "")
    .replace(/^kimi-/, "");
  return (
    (["k2.8", "k2.8-code", "k2.8-preview", "k2.7-code", "for-coding"].includes(base)
      ? "kimi-for-coding"
      : ["k2.7-code-highspeed", "for-coding-highspeed"].includes(base)
        ? "kimi-for-coding-highspeed"
        : base) + suffix
  );
}
function parameters(schema: Record<string, any>): Record<string, any> {
  function resolve(value: any, refs: Set<string>): any {
    if (Array.isArray(value)) {
      return value.map((item) => resolve(item, refs));
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    let source = value;
    if (typeof value.$ref === "string") {
      if (!value.$ref.startsWith("#/") || refs.has(value.$ref)) {
        throw new Error("Unsupported recursive or external Kimi tool schema reference.");
      }
      let target: any = schema;
      for (const key of value.$ref.slice(2).split("/")) {
        const decoded = key.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!target || typeof target !== "object" || !Object.hasOwn(target, decoded)) {
          throw new Error("Invalid Kimi tool schema reference.");
        }
        target = target[decoded];
      }
      source = { ...resolve(target, new Set([...refs, value.$ref])), ...value };
      delete source.$ref;
    }
    return Object.fromEntries(
      Object.entries(source)
        .filter(([key]) => key !== "$defs" && key !== "definitions")
        .map(([key, item]) => [key, resolve(item, refs)]),
    );
  }
  const result = resolve(schema, new Set());
  return { ...result, type: result.type ?? "object" };
}
function adapter(provider: "kimi" | "kimi-ai"): ProviderAdapter {
  const domain = provider === "kimi" ? "kimi.com" : "kimi.ai";
  const authURL = `https://auth.${domain}/api/oauth`;
  const apiURL = `https://api.${domain}/coding`;
  async function form(
    path: string,
    values: Record<string, string>,
    deviceID: string,
    context: ProviderContext,
  ) {
    return context.fetch(`${authURL}/${path}`, {
      method: "POST",
      headers: {
        ...headers(deviceID),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ client_id: clientID, ...values }),
      signal: context.signal,
    });
  }
  function tokenState(
    data: Record<string, unknown>,
    deviceID: string,
    previous?: CredentialState,
  ): Result<CredentialState> {
    if (typeof data.access_token !== "string" || !data.access_token.trim()) {
      return fail("provider-error", "Kimi returned no access token.");
    }
    return ok({
      provider,
      authenticatedAt: previous?.authenticatedAt ?? new Date().toISOString(),
      credentials: {
        accessToken: data.access_token,
        refreshToken:
          typeof data.refresh_token === "string" && data.refresh_token
            ? data.refresh_token
            : (previous?.credentials.refreshToken ?? null),
        deviceID,
        expiresAt:
          typeof data.expires_in === "number" && data.expires_in > 0
            ? Date.now() + data.expires_in * 1000
            : null,
      },
    });
  }
  return {
    descriptor: {
      id: provider,
      name: provider === "kimi" ? "Kimi" : "Kimi AI",
      authMethods: ["device", "api-key"],
      endpoints: ["models", "chat.completions", "responses", "count_tokens", "messages"],
      quota: true,
      modelDiscovery: "catalog",
    },
    async beginAuth(context, options) {
      if (options?.method && options.method !== "device") {
        return fail("unsupported", "Kimi uses device authorization.");
      }
      const deviceID = randomUUID();
      try {
        const response = await form("device_authorization", {}, deviceID, context);
        if (!response.ok) {
          return fail(
            "provider-error",
            "Could not start Kimi authorization.",
            response.status >= 500,
          );
        }
        const data = (await response.json()) as Record<string, unknown>;
        const url = data.verification_uri_complete ?? data.verification_uri;
        if (
          typeof data.device_code !== "string" ||
          typeof url !== "string" ||
          !url.startsWith("https://") ||
          typeof data.expires_in !== "number" ||
          data.expires_in <= 0
        ) {
          return fail("provider-error", "Kimi returned invalid device authorization.");
        }
        const code = data.device_code;
        return ok(
          createDeviceSession({
            url,
            userCode: typeof data.user_code === "string" ? data.user_code : null,
            expiresInSeconds: data.expires_in,
            intervalSeconds: typeof data.interval === "number" ? data.interval : 5,
            signal: context.signal,
            poll: async (signal) => {
              try {
                const res = await form(
                  "token",
                  { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code },
                  deviceID,
                  { ...context, signal },
                );
                const token = (await res.json()) as Record<string, unknown>;
                if (token.error === "authorization_pending" || token.error === "slow_down") {
                  return { pending: true, slowDown: token.error === "slow_down" };
                }
                if (token.error === "expired_token") {
                  return fail("auth-expired", "Kimi authorization expired.");
                }
                if (token.error === "access_denied") {
                  return fail("auth-denied", "Kimi authorization was denied.");
                }
                if (!res.ok || token.error) {
                  return fail("provider-error", "Kimi authorization failed.", res.status >= 500);
                }
                return tokenState(token, deviceID);
              } catch {
                return fail(
                  signal.aborted ? "cancelled" : "network-error",
                  signal.aborted
                    ? "Kimi authorization cancelled."
                    : "Could not reach Kimi authorization.",
                  !signal.aborted,
                );
              }
            },
          }),
        );
      } catch {
        return fail(
          context.signal.aborted ? "cancelled" : "network-error",
          "Could not start Kimi authorization.",
          !context.signal.aborted,
        );
      }
    },
    async connect(input) {
      if (input.kind !== "api-key") {
        return fail("unsupported", "Kimi expects an API key.");
      }
      if (!input.apiKey.trim() || input.baseURL || input.headers) {
        return fail("invalid-state", "Provide a Kimi API key without custom endpoint or headers.");
      }
      return ok({
        provider,
        authenticatedAt: new Date().toISOString(),
        credentials: { apiKey: input.apiKey.trim(), deviceID: randomUUID() },
      });
    },
    async checkAuth(state, context, options) {
      if (state.provider !== provider) {
        return fail("invalid-state", "Incorrect Kimi provider state.");
      }
      if (typeof state.credentials.apiKey === "string" && state.credentials.apiKey.trim()) {
        return ok(state);
      }
      if (typeof state.credentials.accessToken !== "string" || !state.credentials.accessToken) {
        return fail("auth-required", "Sign in to Kimi.");
      }
      if (
        !options?.forceRefresh &&
        (typeof state.credentials.expiresAt !== "number" ||
          state.credentials.expiresAt > Date.now() + 300_000)
      ) {
        return ok(state);
      }
      if (typeof state.credentials.refreshToken !== "string" || !state.credentials.refreshToken) {
        return fail("auth-required", "Sign in to Kimi again.");
      }
      try {
        const deviceID =
          typeof state.credentials.deviceID === "string"
            ? state.credentials.deviceID
            : randomUUID();
        const res = await form(
          "token",
          { grant_type: "refresh_token", refresh_token: state.credentials.refreshToken },
          deviceID,
          context,
        );
        if (res.status === 401 || res.status === 403) {
          return fail("auth-required", "Sign in to Kimi again.");
        }
        const data = (await res.json()) as Record<string, unknown>;
        if (data.error === "invalid_grant") {
          return fail("auth-required", "Sign in to Kimi again.");
        }
        if (!res.ok || data.error) {
          return fail("provider-error", "Kimi token refresh failed.", res.status >= 500);
        }
        return tokenState(data, deviceID, state);
      } catch {
        return fail(
          context.signal.aborted ? "cancelled" : "network-error",
          "Could not refresh Kimi credentials.",
          !context.signal.aborted,
        );
      }
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
    async getQuota(state, context) {
      const token = state.credentials.apiKey ?? state.credentials.accessToken;
      if (typeof token !== "string" || !token)
        return fail("auth-required", "Kimi authentication required.");
      const result = await quotaJSON(context, `${apiURL}/v1/usages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!result.ok) return result;
      const rows = [
        ...(Array.isArray(result.value.limits) ? result.value.limits : []),
        ...(result.value.usage ? [{ name: "weekly", detail: result.value.usage }] : []),
      ];
      const monthly = record(record(result.value.usages).limit_month_total),
        ratio = number(monthly.used_ratio);
      const windows = rows.map((value, index) => {
        const row = record(value),
          detail = record(row.detail ?? row),
          period = record(row.window);
        const limit = number(detail.limit),
          used = number(detail.used);
        const remaining =
          number(detail.remaining) ??
          (limit !== null && used !== null ? Math.max(0, limit - used) : null);
        const duration = number(period.duration ?? row.duration ?? detail.duration),
          unit = String(period.timeUnit ?? row.timeUnit ?? detail.timeUnit ?? "")
            .toLowerCase()
            .replace(/^time_unit_/, "");
        const scale =
          unit === "second" || unit === "seconds"
            ? 1
            : unit === "minute" || unit === "minutes"
              ? 60
              : unit === "hour" || unit === "hours"
                ? 3600
                : unit === "day" || unit === "days"
                  ? 86400
                  : null;
        const resetIn = number(detail.reset_in ?? detail.resetIn ?? detail.ttl);
        return window(String(row.name ?? detail.name ?? `limit-${index + 1}`), {
          limit,
          remaining,
          remainingPercent:
            limit !== null && limit > 0 && remaining !== null
              ? percent((remaining / limit) * 100)
              : null,
          durationSeconds: duration !== null && scale !== null ? duration * scale : null,
          resetsAt:
            timestamp(detail.reset_at ?? detail.resetAt ?? detail.reset_time ?? detail.resetTime) ??
            (resetIn !== null && resetIn >= 0 ? timestamp(Date.now() / 1000 + resetIn) : null),
        });
      });
      if (ratio !== null)
        windows.push(
          window("monthly", {
            remainingPercent: percent((1 - ratio) * 100),
            resetsAt: timestamp(monthly.reset_time),
          }),
        );
      return quota(windows);
    },
    async listModels() {
      return ok(
        modelIDs.map((id, i) => ({
          id,
          object: "model" as const,
          created: created[i]!,
          owned_by: "moonshot",
        })),
      );
    },
    async execute(request, state, context) {
      const path = new URL(request.url).pathname;
      if (
        ["/v1/messages", "/v1/messages/count_tokens", "/v1/chat/completions/count_tokens"].includes(
          path,
        )
      ) {
        return executeAnthropic(request, (body, signal, action) =>
          context.fetch(
            `${apiURL}/v1/messages${action === "count" ? "/count_tokens?beta=true" : ""}`,
            {
              method: "POST",
              headers: {
                ...headers(String(state.credentials.deviceID ?? "")),
                "Content-Type": "application/json",
                "anthropic-version": "2023-06-01",
                Authorization: `Bearer ${state.credentials.apiKey ?? state.credentials.accessToken}`,
              },
              body: JSON.stringify({ ...body, model: nativeModel(String(body.model)) }),
              signal: AbortSignal.any([signal, context.signal]),
              redirect: "error",
            },
          ),
        );
      }
      if (!["/v1/chat/completions", "/v1/responses"].includes(path) || request.method !== "POST") {
        return protocolError("Kimi supports Chat Completions and Responses only.", 404);
      }
      const token = state.credentials.apiKey ?? state.credentials.accessToken;
      if (typeof token !== "string" || !token) {
        return protocolError("Kimi authentication required.", 401);
      }
      const send = async (body: Record<string, any>, signal: AbortSignal) => {
        if (typeof body.model !== "string") {
          return protocolError("A model is required.");
        }
        const normalized: Record<string, any> = { ...body, model: nativeModel(body.model) };
        try {
          for (const key of ["tools", "functions"]) {
            if (Array.isArray(normalized[key])) {
              normalized[key] = normalized[key].map((tool: any) => {
                const fn = tool.function ?? tool;
                if (!fn.parameters || typeof fn.parameters !== "object") {
                  return tool;
                }
                const next = { ...fn, parameters: parameters(fn.parameters) };
                return tool.function ? { ...tool, function: next } : next;
              });
            }
          }
        } catch {
          return protocolError("Kimi tool schemas require valid, nonrecursive local references.");
        }
        if (
          normalized.temperature !== undefined &&
          normalized.temperature !== (normalized.thinking?.type === "disabled" ? 0.6 : 1)
        ) {
          delete normalized.temperature;
        }
        return context.fetch(`${apiURL}${path}`, {
          method: "POST",
          headers: {
            ...headers(String(state.credentials.deviceID ?? "")),
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(normalized),
          signal: AbortSignal.any([signal, context.signal]),
        });
      };
      return send((await request.json()) as Record<string, any>, request.signal);
    },
  };
}
export const kimi = adapter("kimi");
export const kimiAI = adapter("kimi-ai");
export const createProvider = (id: "kimi" | "kimi-ai" = "kimi"): ProviderAdapter => adapter(id);
