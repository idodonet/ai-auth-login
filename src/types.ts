import type OpenAI from "openai";
import type { ClientOptions } from "openai";

export type Provider =
  | "codex"
  | "claude"
  | "antigravity"
  | "kimi"
  | "kimi-ai"
  | "xai"
  | "devin"
  | "meta"
  | "gemini"
  | "gemini-interactions"
  | "vertex"
  | "aistudio"
  | "openai-compatibility";
export type ProviderInput = Provider | "kimi.ai" | "kimi.com";
/** Opaque JSON text containing secrets. Persist without inspecting it. */
export type SavedState = string;
export type SDKOptions = Omit<
  ClientOptions,
  "apiKey" | "adminAPIKey" | "baseURL" | "provider" | "dataResidency" | "workloadIdentity"
>;
export type ErrorCode =
  | "invalid-state"
  | "unsupported-state-version"
  | "invalid-callback"
  | "auth-denied"
  | "auth-expired"
  | "auth-required"
  | "network-error"
  | "rate-limited"
  | "unsupported"
  | "cancelled"
  | "closed"
  | "provider-error";
export interface ProviderError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: ProviderError };
export type AuthStatus =
  | { valid: true }
  | {
      valid: false;
      reason: "missing-state" | "invalid-state" | "unsupported-state-version" | "reauth-required";
    };
export interface AuthOptions {
  method?: "callback" | "device";
}
export type AuthSession =
  | {
      readonly kind: "callback";
      readonly url: string;
      readonly expiresAt: string;
      complete(callbackURL: string): Promise<Result<void>>;
      cancel(): void;
    }
  | {
      readonly kind: "device";
      readonly url: string;
      readonly userCode: string | null;
      readonly expiresAt: string;
      wait(): Promise<Result<void>>;
      cancel(): void;
    };
export interface Account {
  id: string | null;
  email: string | null;
  plan: string | null;
  isFree: boolean | null;
  lastAuthenticatedAt: string | null;
}
export interface QuotaWindow {
  name: string;
  model: string | null;
  durationSeconds: number | null;
  remainingPercent: number | null;
  remaining: number | null;
  limit: number | null;
  unit: "requests" | "tokens" | "credits" | null;
  resetsAt: string | null;
}
export interface Quota {
  supported: boolean;
  checkedAt: string;
  windows: readonly QuotaWindow[];
}
export interface SessionStats {
  startedAt: string;
  requestsSent: number;
  requestsFailed: number;
}
export type AuthMethod = "callback" | "device" | "api-key" | "service-account" | "relay";
export type Endpoint =
  "models" | "chat.completions" | "responses" | "embeddings" | "images" | "audio" | "videos";
export interface ProviderDescriptor {
  id: Provider;
  name: string;
  authMethods: readonly AuthMethod[];
  endpoints: readonly Endpoint[];
  quota: boolean;
  modelDiscovery?: "live" | "catalog" | "configured" | "unsupported";
}
export type ConnectCredentials =
  | {
      kind: "api-key";
      apiKey: string;
      baseURL?: string;
      project?: string;
      location?: string;
      headers?: Record<string, string>;
    }
  | {
      kind: "service-account";
      serviceAccount: string | Record<string, unknown>;
      project?: string;
      location?: string;
    }
  | { kind: "relay"; url?: string; token?: string };
export type Model = OpenAI.Model;

export interface RelayConnection {
  url: string;
  token: string;
}
