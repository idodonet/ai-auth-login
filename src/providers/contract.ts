import type WebSocket from "ws";
import type {
  Account,
  AuthOptions,
  ConnectCredentials,
  Model,
  Provider,
  ProviderDescriptor,
  Quota,
  RelayConnection,
  Result,
} from "../types.js";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/** Internal and versioned by state.ts; never a public persistence contract. */
export interface CredentialState {
  provider: Provider;
  authenticatedAt: string | null;
  credentials: Record<string, JsonValue>;
}
export interface ProviderContext {
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
}
export type AdapterAuthSession =
  | {
      kind: "callback";
      url: string;
      expiresAt: string;
      complete(callbackURL: string): Promise<Result<CredentialState>>;
      cancel(): void;
    }
  | {
      kind: "device";
      url: string;
      userCode: string | null;
      expiresAt: string;
      wait(): Promise<Result<CredentialState>>;
      cancel(): void;
    };
export interface ProviderAdapter {
  descriptor: ProviderDescriptor;
  beginAuth(context: ProviderContext, options?: AuthOptions): Promise<Result<AdapterAuthSession>>;
  connect(input: ConnectCredentials, context: ProviderContext): Promise<Result<CredentialState>>;
  /** Validate and refresh credentials if necessary. auth-required means unusable. */
  checkAuth(
    state: CredentialState,
    context: ProviderContext,
    options?: { validate?: boolean; forceRefresh?: boolean },
  ): Promise<Result<CredentialState>>;
  getAccount(state: CredentialState, context: ProviderContext): Promise<Result<Account | null>>;
  getQuota(state: CredentialState, context: ProviderContext): Promise<Result<Quota>>;
  listModels(state: CredentialState, context: ProviderContext): Promise<Result<readonly Model[]>>;
  /** Request uses canonical SDK-facing /v1/... paths. Preserve upstream status, headers and streaming. */
  execute(request: Request, state: CredentialState, context: ProviderContext): Promise<Response>;
  openResponsesSocket?(
    state: CredentialState,
    context: ProviderContext,
  ): Promise<Result<WebSocket>>;
  getConnection?(): RelayConnection | null;
  close?(): void | Promise<void>;
}
