import { collectGeminiStream } from "../../protocols/gemini.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fail, ok } from "../../result.js";
import type { Result } from "../../types.js";
import type { CredentialState, JsonValue, ProviderAdapter, ProviderContext } from "../contract.js";
import { executeGemini } from "../../protocols/gemini.js";
import { createOAuthSession, createPKCE } from "../../auth/oauth.js";
import { quota, quotaJSON, record, number, percent, timestamp, window } from "../quota.js";

const clientId = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
// Public installed-application client credentials from CLIProxyAPI, not an account secret.
const clientSecret = "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";
const tokenURL = "https://oauth2.googleapis.com/token";
const daily = "https://daily-cloudcode-pa.googleapis.com/v1internal:";
const prod = "https://cloudcode-pa.googleapis.com/v1internal:";
const userAgent = "antigravity/hub/2.9.1 darwin/arm64";
type ObjectValue = Record<string, JsonValue>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

async function json(
  context: ProviderContext,
  url: string,
  init: RequestInit,
): Promise<Result<ObjectValue>> {
  try {
    const response = await context.fetch(url, { ...init, signal: context.signal });
    if (!response.ok) {
      if (url === tokenURL && response.status === 400) {
        try {
          const error: unknown = await response.json();
          if (object(error).error === "invalid_grant")
            return fail(
              "auth-required",
              "Google authorization has expired or been revoked; sign in again.",
            );
        } catch {
          /* Preserve the status-based error for malformed token errors. */
        }
      }
      return fail(
        response.status === 401 || response.status === 403
          ? "auth-required"
          : response.status === 429
            ? "rate-limited"
            : "provider-error",
        `Antigravity request failed (${response.status}).`,
        response.status === 429 || response.status >= 500,
      );
    }
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return fail("provider-error", "Antigravity returned an invalid response.");
    }
    return ok(object(value));
  } catch {
    return fail(
      context.signal.aborted ? "cancelled" : "network-error",
      context.signal.aborted ? "Operation cancelled." : "Could not reach Antigravity.",
      !context.signal.aborted,
    );
  }
}

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": userAgent,
  };
}

function project(value: ObjectValue): string | null {
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const id = text(value[key]) ?? text(object(value[key]).id);
    if (id) {
      return id;
    }
  }
  return null;
}

async function discover(
  accessToken: string,
  context: ProviderContext,
): Promise<Result<ObjectValue>> {
  const user = await json(context, "https://www.googleapis.com/oauth2/v2/userinfo?alt=json", {
    headers: headers(accessToken),
  });
  if (!user.ok) {
    return user;
  }
  if (!text(user.value.email)) {
    return fail("provider-error", "Google did not return an account email.");
  }
  const loadRequest = {
    method: "POST",
    headers: headers(accessToken),
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
  };
  const load = await json(context, `${prod}loadCodeAssist`, loadRequest);
  if (!load.ok) {
    return load;
  }
  const currentTier = object(load.value.currentTier);
  let projectId = project(load.value);
  if (!projectId) {
    const tiers = Array.isArray(load.value.allowedTiers) ? load.value.allowedTiers.map(object) : [];
    const tier =
      text(tiers.find((value) => value.isDefault === true)?.id) ??
      text(currentTier.id) ??
      "free-tier";
    for (let attempt = 0; attempt < 5; attempt++) {
      const onboard = await json(context, `${daily}onboardUser`, {
        method: "POST",
        headers: {
          ...headers(accessToken),
          "user-agent": `${userAgent} google-api-nodejs-client/10.3.0`,
          "x-goog-api-client": "gl-node/22.21.1",
        },
        body: JSON.stringify({
          tier_id: tier,
          metadata: { ide_type: "ANTIGRAVITY", ide_version: "2.9.1", ide_name: "antigravity" },
        }),
      });
      if (!onboard.ok) {
        return onboard;
      }
      if (onboard.value.done === true) {
        projectId = project(object(onboard.value.response));
        if (!projectId) {
          const reloaded = await json(context, `${prod}loadCodeAssist`, loadRequest);
          if (!reloaded.ok) {
            return reloaded;
          }
          projectId = project(reloaded.value);
          if (!projectId) {
            return fail(
              "provider-error",
              "Antigravity account provisioning did not provide a project. Sign in to the official Antigravity app with the same Google account, finish onboarding, then start a fresh login.",
            );
          }
        }
        break;
      }
      if (attempt < 4) {
        try {
          await delay(2000, undefined, { signal: context.signal });
        } catch {
          return fail("cancelled", "Operation cancelled.");
        }
      }
    }
  }
  if (!projectId) {
    return fail(
      "provider-error",
      "Antigravity onboarding did not finish after five attempts. Try signing in again.",
      true,
    );
  }
  return ok({
    project: projectId,
    email: user.value.email!,
    accountId: text(user.value.id),
    plan: text(currentTier.id),
  });
}

async function tokens(
  context: ProviderContext,
  parameters: Record<string, string>,
): Promise<Result<ObjectValue>> {
  const response = await json(context, tokenURL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...parameters }),
  });
  if (!response.ok) {
    return response;
  }
  if (
    !text(response.value.access_token) ||
    typeof response.value.expires_in !== "number" ||
    !Number.isFinite(response.value.expires_in) ||
    response.value.expires_in <= 0
  ) {
    return fail("provider-error", "Google returned invalid token credentials.");
  }
  return ok({
    accessToken: response.value.access_token!,
    refreshToken: text(response.value.refresh_token),
    expiresAt: new Date(Date.now() + response.value.expires_in * 1000).toISOString(),
  });
}

async function modelData(
  state: CredentialState,
  context: ProviderContext,
): Promise<Result<ObjectValue>> {
  const token = text(state.credentials.accessToken);
  if (!token) {
    return fail("auth-required", "Sign in to Antigravity first.");
  }
  return json(context, `${daily}fetchAvailableModels`, {
    method: "POST",
    headers: headers(token),
    body: "{}",
  });
}

export const antigravity: ProviderAdapter = {
  descriptor: {
    id: "antigravity",
    name: "Antigravity",
    authMethods: ["callback"],
    endpoints: [
      "models",
      "chat.completions",
      "responses",
      "count_tokens",
      "generateContent",
      "responses.compact",
    ],
    quota: true,
    modelDiscovery: "live",
  },
  async beginAuth(context, options) {
    if (options?.method === "device") {
      return fail("unsupported", "Antigravity uses callback authentication.");
    }
    const redirectURI = "http://localhost:51121/oauth-callback";
    const { state, verifier, challenge } = createPKCE();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectURI,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: [
        "cloud-platform",
        "userinfo.email",
        "userinfo.profile",
        "cclog",
        "experimentsandconfigs",
      ]
        .map((scope) => `https://www.googleapis.com/auth/${scope}`)
        .join(" "),
    }).toString();
    return ok(
      createOAuthSession({
        url: url.toString(),
        redirectURI,
        state,
        signal: context.signal,
        exchange: async (code, signal) => {
          const loginContext = { ...context, signal };
          const token = await tokens(loginContext, {
            code,
            redirect_uri: redirectURI,
            grant_type: "authorization_code",
            code_verifier: verifier,
          });
          if (!token.ok) {
            return token;
          }
          if (!text(token.value.refreshToken)) {
            return fail(
              "provider-error",
              "Google did not return a refresh token; authorize offline access again.",
            );
          }
          const account = await discover(String(token.value.accessToken), loginContext);
          if (!account.ok) {
            return account;
          }
          return ok({
            provider: "antigravity" as const,
            authenticatedAt: new Date().toISOString(),
            credentials: { ...token.value, ...account.value },
          });
        },
      }),
    );
  },
  async connect() {
    return fail("unsupported", "Antigravity requires browser authentication.");
  },
  async checkAuth(state, context, options) {
    const { accessToken, refreshToken, expiresAt } = state.credentials;
    if (
      state.provider !== "antigravity" ||
      !text(state.credentials.project) ||
      !text(accessToken) ||
      !text(expiresAt) ||
      !Number.isFinite(Date.parse(String(expiresAt)))
    ) {
      return fail("auth-required", "Antigravity state is missing valid credentials.");
    }
    if (!options?.forceRefresh && Date.parse(String(expiresAt)) > Date.now() + 60_000) {
      return ok(state);
    }
    if (!text(refreshToken)) {
      return fail("auth-required", "Antigravity login has expired.");
    }
    const updated = await tokens(context, {
      grant_type: "refresh_token",
      refresh_token: String(refreshToken),
    });
    if (!updated.ok) {
      return updated;
    }
    return ok({
      ...state,
      credentials: {
        ...state.credentials,
        ...updated.value,
        refreshToken: updated.value.refreshToken ?? refreshToken!,
      },
    });
  },
  async getAccount(state) {
    const plan = text(state.credentials.plan);
    return ok({
      id: text(state.credentials.accountId),
      email: text(state.credentials.email),
      plan,
      isFree: plan === "free-tier" ? true : null,
      lastAuthenticatedAt: state.authenticatedAt,
    });
  },
  async getQuota(state, context) {
    const token = text(state.credentials.accessToken),
      projectId = text(state.credentials.project);
    if (!token || !projectId) return fail("auth-required", "Sign in to Antigravity first.");
    let last: Awaited<ReturnType<typeof quotaJSON>> | undefined;
    for (const endpoint of [
      daily,
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:",
      prod,
    ]) {
      const result = await quotaJSON(context, `${endpoint}retrieveUserQuotaSummary`, {
        method: "POST",
        headers: {
          ...headers(token),
          "user-agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
        },
        body: JSON.stringify({ project: projectId }),
      });
      last = result;
      if (!result.ok) {
        if (context.signal.aborted) return result;
        continue;
      }
      if (!Array.isArray(result.value.groups)) continue;
      const windows = result.value.groups.flatMap((value) => {
        const group = record(value);
        return (Array.isArray(group.buckets) ? group.buckets : []).flatMap((value) => {
          const bucket = record(value),
            fraction = number(bucket.remainingFraction ?? bucket.remaining_fraction);
          if (fraction === null) return [];
          const period = String(bucket.window ?? "");
          return [
            window(
              `${group.displayName ?? group.display_name ?? "quota"}: ${bucket.displayName ?? bucket.display_name ?? period}`,
              {
                remainingPercent: percent(fraction * 100),
                resetsAt: timestamp(bucket.resetTime ?? bucket.reset_time),
                durationSeconds: ["5h", "five-hour", "five_hour"].includes(period)
                  ? 18000
                  : ["weekly", "week"].includes(period)
                    ? 604800
                    : null,
              },
            ),
          ];
        });
      });
      return quota(windows);
    }
    return last && !last.ok
      ? last
      : fail("provider-error", "Antigravity returned no quota groups.");
  },
  async listModels(state, context) {
    const data = await modelData(state, context);
    if (!data.ok) {
      return data;
    }
    if (
      !data.value.models ||
      typeof data.value.models !== "object" ||
      Array.isArray(data.value.models)
    ) {
      return fail("provider-error", "Antigravity did not return a model map.");
    }
    return ok(
      Object.keys(data.value.models).map((id) => ({
        id,
        object: "model" as const,
        created: 0,
        owned_by: "antigravity",
      })),
    );
  },
  async execute(request, state, context) {
    const token = text(state.credentials.accessToken),
      projectId = text(state.credentials.project);
    if (!token || !projectId) {
      return Response.json(
        { error: { message: "Antigravity login is required.", type: "authentication_error" } },
        { status: 401 },
      );
    }
    return executeGemini(
      request,
      async (body, signal, action) => {
        const { model, stream, ...native } = body;
        const collect =
          action !== "count" &&
          !stream &&
          /claude|gemini-3-pro|gemini-3\.1-flash-image/.test(String(model));
        const response = await context.fetch(
          `${daily}${action === "count" ? "countTokens" : stream || collect ? "streamGenerateContent?alt=sse" : "generateContent"}`,
          {
            method: "POST",
            headers: headers(token),
            signal: AbortSignal.any([signal, context.signal]),
            body: JSON.stringify(
              action === "count"
                ? { request: native }
                : {
                    project: projectId,
                    model,
                    userAgent: "antigravity",
                    requestType: String(model).includes("image") ? "image_gen" : "agent",
                    requestId: randomUUID(),
                    request: native,
                  },
            ),
          },
        );
        return collect && response.ok ? collectGeminiStream(response, signal) : response;
      },
      true,
    );
  },
};

export const createProvider = (): ProviderAdapter => antigravity;
