import { createPrivateKey, sign } from "node:crypto";
import { ok, fail } from "../../result.js";
import type { ProviderAdapter } from "../contract.js";
import { executeGemini } from "../../protocols/gemini.js";

const tokenURI = "https://oauth2.googleapis.com/token";
const locations = /^[a-z]+(?:-[a-z]+)+\d$/;
export const vertex: ProviderAdapter = {
  descriptor: {
    id: "vertex",
    name: "Vertex AI",
    authMethods: ["api-key", "service-account"],
    endpoints: ["models", "chat.completions", "responses", "count_tokens", "generateContent"],
    quota: false,
    modelDiscovery: "catalog",
  },
  async beginAuth() {
    return fail("unsupported", "Vertex requires an API key or service account.");
  },
  async connect(input) {
    try {
      const location = input.kind === "relay" ? "global" : (input.location ?? "global");
      if (location !== "global" && !locations.test(location)) {
        return fail("invalid-state", "Invalid Vertex location.");
      }
      if (input.kind === "api-key") {
        if (
          typeof input.apiKey !== "string" ||
          !input.apiKey.trim() ||
          input.baseURL ||
          input.headers
        ) {
          return fail(
            "invalid-state",
            "Provide a Vertex API key without endpoint or header overrides.",
          );
        }
        return ok({
          provider: "vertex",
          authenticatedAt: new Date().toISOString(),
          credentials: { apiKey: input.apiKey, location },
        });
      }
      if (input.kind !== "service-account") {
        return fail("invalid-state", "Vertex requires a service account or API key.");
      }
      const account =
        typeof input.serviceAccount === "string"
          ? JSON.parse(input.serviceAccount)
          : input.serviceAccount;
      if (
        !account ||
        account.type !== "service_account" ||
        typeof account.client_email !== "string" ||
        !/^[^@\s]+@[^@\s]+$/.test(account.client_email) ||
        typeof account.private_key !== "string" ||
        (account.token_uri !== undefined && account.token_uri !== tokenURI)
      ) {
        return fail("invalid-state", "Invalid Google service account.");
      }
      const key = createPrivateKey(account.private_key);
      if (key.asymmetricKeyType !== "rsa") {
        return fail("invalid-state", "Service account requires an RSA key.");
      }
      const project = input.project ?? account.project_id;
      if (typeof project !== "string" || !/^[a-z][a-z0-9-]{4,62}[a-z0-9]$/.test(project)) {
        return fail("invalid-state", "Invalid Google project ID.");
      }
      return ok({
        provider: "vertex",
        authenticatedAt: new Date().toISOString(),
        credentials: {
          clientEmail: account.client_email,
          privateKey: account.private_key,
          project,
          location,
        },
      });
    } catch {
      return fail("invalid-state", "Invalid Google service account JSON or private key.");
    }
  },
  async checkAuth(state, context, options) {
    const c = state.credentials;
    if (
      typeof c.location !== "string" ||
      (c.location !== "global" && !locations.test(c.location))
    ) {
      return fail("invalid-state", "Invalid Vertex location.");
    }
    if (typeof c.apiKey === "string" && c.apiKey) {
      return ok(state);
    }
    if (
      typeof c.clientEmail !== "string" ||
      typeof c.privateKey !== "string" ||
      typeof c.project !== "string"
    ) {
      return fail("auth-required", "Vertex service account credentials are missing.");
    }
    try {
      if (
        createPrivateKey(c.privateKey).asymmetricKeyType !== "rsa" ||
        !/^[a-z][a-z0-9-]{4,62}[a-z0-9]$/.test(c.project) ||
        !/^[^@\s]+@[^@\s]+$/.test(c.clientEmail)
      ) {
        return fail("invalid-state", "Invalid Google service account.");
      }
    } catch {
      return fail("invalid-state", "Invalid Google service account private key.");
    }
    if (
      !options?.forceRefresh &&
      typeof c.accessToken === "string" &&
      typeof c.expiresAt === "number" &&
      c.expiresAt > Date.now() + 60_000
    ) {
      return ok(state);
    }
    try {
      const now = Math.floor(Date.now() / 1000);
      const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
      const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: c.clientEmail, scope: "https://www.googleapis.com/auth/cloud-platform", aud: tokenURI, iat: now, exp: now + 3600 })}`;
      const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), c.privateKey).toString("base64url")}`;
      const response = await context.fetch(tokenURI, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
        signal: context.signal,
      });
      if (!response.ok) {
        let invalidGrant = false;
        if (response.status === 400) {
          try {
            invalidGrant =
              ((await response.json()) as { error?: unknown }).error === "invalid_grant";
          } catch {
            /* Use status classification. */
          }
        }
        return fail(
          response.status === 429
            ? "rate-limited"
            : response.status === 401 || response.status === 403 || invalidGrant
              ? "auth-required"
              : "provider-error",
          `Google token exchange failed (${response.status}).`,
          response.status >= 500 || response.status === 429,
        );
      }
      const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
      if (
        typeof body.access_token !== "string" ||
        !body.access_token ||
        typeof body.expires_in !== "number" ||
        !Number.isFinite(body.expires_in) ||
        body.expires_in <= 0
      ) {
        return fail("provider-error", "Google returned invalid token credentials.");
      }
      return ok({
        ...state,
        credentials: {
          ...c,
          accessToken: body.access_token,
          expiresAt: Date.now() + body.expires_in * 1000,
        },
      });
    } catch {
      return fail(
        context.signal.aborted ? "cancelled" : "network-error",
        "Google token exchange could not complete.",
        true,
      );
    }
  },
  async getAccount(state) {
    return ok({
      id: typeof state.credentials.project === "string" ? state.credentials.project : null,
      email:
        typeof state.credentials.clientEmail === "string" ? state.credentials.clientEmail : null,
      plan: null,
      isFree: null,
      lastAuthenticatedAt: state.authenticatedAt,
    });
  },
  async getQuota() {
    return ok({ supported: false, checkedAt: new Date().toISOString(), windows: [] });
  },
  // CLIProxyAPI e2bff01 internal/registry/models/models.json vertex catalog; project access is not guaranteed.
  async listModels() {
    return ok(
      [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-image",
        "gemini-2.5-flash-lite",
        "gemini-3-pro",
        "gemini-3-flash",
        "gemini-3.1-pro",
        "gemini-3.1-pro-preview",
        "gemini-3.1-flash-image",
        "gemini-3.1-flash-lite",
        "gemini-3-pro-image",
        "imagen-4.0-generate-001",
        "imagen-4.0-ultra-generate-001",
        "imagen-3.0-generate-002",
        "imagen-3.0-fast-generate-001",
        "imagen-4.0-fast-generate-001",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.6-flash",
        "gemini-3.7-flash",
        "gemini-3.8-flash",
      ].map((id) => ({ id, object: "model" as const, created: 0, owned_by: "google" })),
    );
  },
  execute(request, state, context) {
    const c = state.credentials;
    const location = typeof c.location === "string" ? c.location : "global";
    const host =
      location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
    const baseURL =
      typeof c.apiKey === "string"
        ? "https://aiplatform.googleapis.com/v1/publishers/google"
        : `https://${host}/v1/projects/${encodeURIComponent(String(c.project))}/locations/${encodeURIComponent(location)}/publishers/google`;
    const headers: Record<string, string> =
      typeof c.apiKey === "string"
        ? { "x-goog-api-key": c.apiKey }
        : { Authorization: `Bearer ${String(c.accessToken)}` };
    return executeGemini(request, async (body, signal, action) => {
      const { model, stream: streamValue, ...payload } = body;
      const stream = streamValue === true;
      return context.fetch(
        `${baseURL}/models/${encodeURIComponent(String(model))}:${action === "count" ? "countTokens" : stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        },
      );
    });
  },
};

export const createVertexProvider = () => vertex;
