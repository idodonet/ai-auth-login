import type {
  Account,
  AuthMethod,
  AuthStatus,
  ConnectCredentials,
  Model,
  Provider,
  ProviderDescriptor,
  Quota,
  RelayConnection,
  Result,
  SavedState,
  SessionStats,
} from "ai-auth-login";
export type {
  Account,
  AuthMethod,
  AuthStatus,
  ConnectCredentials,
  Model,
  Provider,
  ProviderDescriptor,
  Quota,
  RelayConnection,
  Result,
  SavedState,
  SessionStats,
};

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "complete" | "streaming" | "stopped" | "error";
}
export interface PersistedTab {
  id: string;
  provider: Provider | null;
  model: string | null;
  sdkState: SavedState | null;
  messages: ChatMessage[];
}
export interface PersistedApp {
  version: 1;
  activeTabId: string;
  tabs: PersistedTab[];
}
export interface LoginView {
  kind: "callback" | "device";
  url: string;
  expiresAt: string;
  userCode: string | null;
}
export interface SessionView {
  id: string;
  provider: Provider | null;
  sdkState: SavedState | null;
  auth: AuthStatus;
  login: LoginView | null;
  account: Account | null;
  quota: Quota | null;
  models: readonly Model[];
  stats: SessionStats;
  connection: RelayConnection | null;
  warnings: string[];
}
export type TabAction =
  | { type: "restore"; state?: SavedState }
  | { type: "begin-auth"; provider: Provider; method?: "callback" | "device" }
  | { type: "complete-auth"; callbackURL: string }
  | { type: "wait-auth" }
  | { type: "cancel-auth" }
  | { type: "connect"; provider: Provider; credentials: ConnectCredentials }
  | { type: "refresh" }
  | { type: "logout" }
  | { type: "close" };
export type SessionEvent =
  | { type: "state"; tabId: string; state: SavedState | null }
  | { type: "session"; tabId: string; session: SessionView };
export interface ChatRequest {
  model: string;
  messages: { role: "user" | "assistant"; content: string }[];
}
export type ChatEvent =
  { type: "delta"; text: string } | { type: "done" } | { type: "error"; message: string };
export interface Bootstrap {
  providers: readonly ProviderDescriptor[];
  token: string;
}
