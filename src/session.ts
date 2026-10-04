import OpenAI from "openai";
import { fail, ok } from "./result.js";
import { decodeState, encodeState } from "./state.js";
import { countedFetch, errorResponse, ownResponse } from "./transport.js";
import { getProvider, listProviders } from "./providers/registry.js";
import type {
  AdapterAuthSession,
  CredentialState,
  ProviderAdapter,
  ProviderContext,
} from "./providers/contract.js";
import type {
  Account,
  AuthOptions,
  AuthSession,
  AuthStatus,
  ConnectCredentials,
  Model,
  Provider,
  ProviderDescriptor,
  ProviderInput,
  Quota,
  RelayConnection,
  Result,
  SavedState,
  SDKOptions,
  SessionStats,
} from "./types.js";

export class ProviderSession {
  private state: CredentialState | null = null;
  private restoreFailure: "missing-state" | "invalid-state" | "unsupported-state-version" =
    "missing-state";
  private adapters = new Map<ProviderInput, ProviderAdapter>();
  private closed = false;
  private generation = 0;
  private revision = 0;
  private refresh = new Map<string, Promise<Result<AuthStatus>>>();
  private listeners = new Set<(state: SavedState | null) => void>();
  private controllers = new Set<AbortController>();
  private logins = new Set<() => void>();
  private stats: SessionStats = {
    startedAt: new Date().toISOString(),
    requestsSent: 0,
    requestsFailed: 0,
  };

  private network: typeof globalThis.fetch;
  constructor(options: { state?: SavedState; fetch?: typeof globalThis.fetch } = {}) {
    this.network = options.fetch ?? globalThis.fetch;
    if (options.state !== undefined) {
      const restored = decodeState(options.state);
      if (restored.ok) {
        this.state = restored.value;
      } else {
        this.restoreFailure =
          restored.error.code === "unsupported-state-version"
            ? "unsupported-state-version"
            : "invalid-state";
      }
    }
  }

  private getAdapter(provider: ProviderInput): ProviderAdapter | undefined {
    let adapter = this.adapters.get(provider);
    if (!adapter) {
      adapter = getProvider(provider);
      if (adapter) {
        this.adapters.set(provider, adapter);
      }
    }
    return adapter;
  }
  get provider(): Provider | null {
    return this.state?.provider ?? null;
  }
  getConnection(): RelayConnection | null {
    return !this.closed && this.state
      ? (this.getAdapter(this.state.provider)?.getConnection?.() ?? null)
      : null;
  }
  static listProviders(): readonly ProviderDescriptor[] {
    return listProviders();
  }
  exportState(): SavedState | null {
    return this.state ? encodeState(this.state) : null;
  }
  getStats(): SessionStats {
    return { ...this.stats };
  }
  onStateChange(listener: (state: SavedState | null) => void): () => void {
    if (!this.closed) {
      this.listeners.add(listener);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(): void {
    const current = this.state;
    const state = this.exportState();
    for (const listener of [...this.listeners]) {
      if (this.closed || this.state !== current) {
        break;
      }
      if (!this.listeners.has(listener)) {
        continue;
      }
      try {
        listener(state);
      } catch {
        /* Storage errors belong to the consumer. */
      }
    }
  }
  private context(fetch: typeof globalThis.fetch = this.network, signal?: AbortSignal) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    return {
      context: { fetch, signal: combined } satisfies ProviderContext,
      finish: () => {
        this.controllers.delete(controller);
      },
      controller,
    };
  }
  private stale(
    generation: number,
    revision?: number,
  ): Extract<Result<never>, { ok: false }> | null {
    if (this.closed) {
      return {
        ok: false,
        error: { code: "closed", message: "Session is closed.", retryable: false },
      };
    }
    if (generation !== this.generation || (revision !== undefined && revision !== this.revision)) {
      return {
        ok: false,
        error: {
          code: "cancelled",
          message: "Session changed while the operation was in progress.",
          retryable: false,
        },
      };
    }
    return null;
  }
  private async safe<T>(
    action: () => Promise<Result<T>>,
    signal?: AbortSignal,
  ): Promise<Result<T>> {
    try {
      const result = await action();
      return signal?.aborted ? fail("cancelled", "Operation was cancelled.") : result;
    } catch {
      return this.closed
        ? fail("closed", "Session is closed.")
        : signal?.aborted
          ? fail("cancelled", "Operation was cancelled.")
          : fail("network-error", "Provider request failed.", true);
    }
  }
  private abortResources(): void {
    for (const cancel of [...this.logins]) {
      cancel();
    }
    for (const controller of this.controllers) {
      controller.abort(new DOMException("Session changed", "AbortError"));
    }
    this.controllers.clear();
  }
  private async commit(state: CredentialState, adapter: ProviderAdapter): Promise<void> {
    this.generation++;
    this.revision++;
    this.abortResources();
    const previous = [...new Set(this.adapters.values())].filter((value) => value !== adapter);
    this.adapters.clear();
    this.adapters.set(state.provider, adapter);
    this.state = structuredClone(state);
    this.emit();
    await Promise.allSettled(previous.map((value) => value.close?.()));
  }

  async checkAuth(): Promise<Result<AuthStatus>> {
    return this.checkCredentials();
  }
  private async checkCredentials(
    fetch?: typeof globalThis.fetch,
    options: { validate?: boolean; forceRefresh?: boolean } = { validate: true },
  ): Promise<Result<AuthStatus>> {
    if (this.closed) {
      return fail("closed", "Session is closed.");
    }
    if (!this.state) {
      return ok({ valid: false, reason: this.restoreFailure });
    }
    const key = JSON.stringify(options);
    const pending = this.refresh.get(key);
    if (pending) {
      return pending;
    }
    const other = this.refresh.values().next().value;
    if (other) {
      const before = this.exportState();
      const result = await other;
      if (!result.ok || !result.value.valid) {
        return result;
      }
      if (options.validate || (options.forceRefresh && before === this.exportState())) {
        return this.checkCredentials(fetch, options);
      }
      return result;
    }
    const generation = this.generation;
    const revision = this.revision;
    const state = structuredClone(this.state);
    const adapter = this.getAdapter(state.provider);
    if (!adapter) {
      return fail("invalid-state", "Saved provider is unavailable.");
    }
    const operation = this.context(fetch);
    const promise = (async (): Promise<Result<AuthStatus>> => {
      try {
        let checked = await this.safe(
          () => adapter.checkAuth(state, operation.context, { ...options, validate: false }),
          operation.context.signal,
        );
        if (options.validate && checked.ok) {
          const stale = this.stale(generation, revision);
          if (stale) {
            return stale;
          }
          if (checked.value.provider !== state.provider) {
            return fail("invalid-state", "Provider returned mismatched credentials.");
          }
          if (encodeState(checked.value) !== this.exportState()) {
            this.state = structuredClone(checked.value);
            this.emit();
          }
          const changed = this.stale(generation, revision);
          if (changed) {
            return changed;
          }
          const prepared = structuredClone(checked.value);
          checked = await this.safe(
            () => adapter.checkAuth(prepared, operation.context, { validate: true }),
            operation.context.signal,
          );
        }
        const stale = this.stale(generation, revision);
        if (stale) {
          return stale;
        }
        if (!checked.ok) {
          if (
            checked.error.code === "auth-required" ||
            checked.error.code === "auth-expired" ||
            checked.error.code === "auth-denied"
          ) {
            return ok({ valid: false, reason: "reauth-required" });
          }
          return checked;
        }
        if (checked.value.provider !== state.provider) {
          return fail("invalid-state", "Provider returned mismatched credentials.");
        }
        if (encodeState(checked.value) !== this.exportState()) {
          this.state = structuredClone(checked.value);
          this.emit();
        }
        return ok({ valid: true });
      } finally {
        operation.finish();
      }
    })();
    this.refresh.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.refresh.get(key) === promise) {
        this.refresh.delete(key);
      }
    }
  }

  async beginAuth(provider: ProviderInput, options?: AuthOptions): Promise<Result<AuthSession>> {
    if (this.closed) {
      return fail("closed", "Session is closed.");
    }
    const adapter = this.getAdapter(provider);
    if (!adapter) {
      return fail("unsupported", "Provider is not supported.");
    }
    const generation = this.generation;
    const revision = ++this.revision;
    for (const cancel of [...this.logins]) {
      cancel();
    }
    const operation = this.context();
    const started = await this.safe(
      () => adapter.beginAuth(operation.context, options),
      operation.context.signal,
    );
    const stale = this.stale(generation, revision);
    if (!started.ok || stale) {
      if (started.ok) {
        started.value.cancel();
      }
      operation.finish();
      return stale ?? (started as Result<never>);
    }
    const login: AdapterAuthSession = started.value;
    let settled = false;
    let running = false;
    const cancel = () => {
      if (!settled) {
        settled = true;
        operation.controller.abort();
        login.cancel();
        operation.finish();
        this.logins.delete(cancel);
      }
    };
    this.logins.add(cancel);
    const complete = async (
      action: () => Promise<Result<CredentialState>>,
    ): Promise<Result<void>> => {
      if (settled) {
        return fail("cancelled", "Login session is no longer active.");
      }
      if (running) {
        return fail("provider-error", "Login completion is already in progress.");
      }
      running = true;
      try {
        const result = await this.safe(action, operation.context.signal);
        const stale = this.stale(generation, revision);
        if (stale) {
          return stale;
        }
        if (!result.ok) {
          return result;
        }
        if (result.value.provider !== adapter.descriptor.id) {
          return fail("invalid-state", "Provider returned mismatched credentials.");
        }
        settled = true;
        operation.finish();
        this.logins.delete(cancel);
        login.cancel();
        await this.commit(result.value, adapter);
        return ok(undefined);
      } finally {
        running = false;
      }
    };
    return ok(
      login.kind === "callback"
        ? {
            kind: "callback",
            url: login.url,
            expiresAt: login.expiresAt,
            cancel,
            complete: (url: string) => complete(() => login.complete(url)),
          }
        : {
            kind: "device",
            url: login.url,
            userCode: login.userCode,
            expiresAt: login.expiresAt,
            cancel,
            wait: () => complete(() => login.wait()),
          },
    );
  }

  async connect(provider: ProviderInput, credentials: ConnectCredentials): Promise<Result<void>> {
    if (this.closed) {
      return fail("closed", "Session is closed.");
    }
    const adapter = this.getAdapter(provider);
    if (!adapter) {
      return fail("unsupported", "Provider is not supported.");
    }
    const generation = this.generation;
    const revision = ++this.revision;
    const operation = this.context();
    try {
      const result = await this.safe(
        () => adapter.connect(credentials, operation.context),
        operation.context.signal,
      );
      const stale = this.stale(generation, revision);
      if (stale) {
        return stale;
      }
      if (!result.ok) {
        return result;
      }
      if (result.value.provider !== adapter.descriptor.id) {
        return fail("invalid-state", "Provider returned mismatched credentials.");
      }
      operation.finish();
      await this.commit(result.value, adapter);
      return ok(undefined);
    } finally {
      operation.finish();
    }
  }

  private async read<T>(
    action: (
      adapter: ProviderAdapter,
      state: CredentialState,
      context: ProviderContext,
    ) => Promise<Result<T>>,
    fetch?: typeof globalThis.fetch,
  ): Promise<Result<T>> {
    const auth = await this.checkCredentials(fetch, { validate: false });
    if (!auth.ok) {
      return auth;
    }
    if (!auth.value.valid || !this.state) {
      return fail("auth-required", "Authenticate this session first.");
    }
    const generation = this.generation;
    const state = structuredClone(this.state);
    const adapter = this.getAdapter(state.provider)!;
    const operation = this.context(fetch);
    try {
      const result = await this.safe(
        () => action(adapter, state, operation.context),
        operation.context.signal,
      );
      return this.stale(generation) ?? result;
    } finally {
      operation.finish();
    }
  }
  async getAccount(): Promise<Result<Account | null>> {
    return this.read((adapter, state, context) => adapter.getAccount(state, context));
  }
  async getQuota(): Promise<Result<Quota>> {
    return this.read((adapter, state, context) => adapter.getQuota(state, context));
  }
  async listModels(): Promise<Result<readonly Model[]>> {
    return this.read((adapter, state, context) => adapter.listModels(state, context));
  }

  async createSDK(options: SDKOptions = {}): Promise<Result<OpenAI>> {
    const network = options.fetch ?? this.network;
    const auth = await this.checkCredentials(network);
    if (!auth.ok) {
      return auth;
    }
    if (!auth.value.valid) {
      return fail("auth-required", "Authenticate this session first.");
    }
    const generation = this.generation;
    const managed = { ...options } as Record<string, unknown>;
    for (const key of [
      "apiKey",
      "adminAPIKey",
      "baseURL",
      "provider",
      "dataResidency",
      "workloadIdentity",
    ]) {
      delete managed[key];
    }
    return ok(
      new OpenAI({
        ...managed,
        apiKey: "internally-managed",
        baseURL: "https://provider-session.invalid/v1",
        fetch: async (input, init) => {
          const stale = this.stale(generation);
          if (stale) {
            return errorResponse(stale.error, 401);
          }
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.origin !== "https://provider-session.invalid") {
            return errorResponse(
              {
                code: "unsupported",
                message: "SDK URL overrides are not supported.",
                retryable: false,
              },
              400,
            );
          }
          const auth = await this.checkCredentials(network, { validate: false });
          const changed = this.stale(generation);
          if (changed) {
            return errorResponse(changed.error, 401);
          }
          if (!auth.ok) {
            return errorResponse(auth.error);
          }
          if (!auth.value.valid || !this.state) {
            return errorResponse(
              {
                code: "auth-required",
                message: "Authenticate this session first.",
                retryable: false,
              },
              401,
            );
          }
          const state = structuredClone(this.state);
          const adapter = this.getAdapter(state.provider)!;
          const operation = this.context(network, request.signal);
          try {
            if (request.method === "GET" && /^\/v1\/models(?:\/[^/]+)?\/?$/.test(url.pathname)) {
              const models = await this.safe(
                () => adapter.listModels(state, operation.context),
                operation.context.signal,
              );
              const changed = this.stale(generation);
              operation.finish();
              if (changed) {
                return errorResponse(changed.error, 401);
              }
              if (!models.ok) {
                return errorResponse(models.error);
              }
              const id = url.pathname.replace(/^\/v1\/models\/?/, "");
              if (id) {
                const model = models.value.find((model) => model.id === decodeURIComponent(id));
                return model
                  ? Response.json(model)
                  : errorResponse(
                      { code: "unsupported", message: "Model was not found.", retryable: false },
                      404,
                    );
              }
              return Response.json({ object: "list", data: models.value });
            }
            const headers = new Headers(request.headers);
            for (const key of [
              "authorization",
              "x-api-key",
              "api-key",
              "x-goog-api-key",
              "host",
              "cookie",
            ]) {
              headers.delete(key);
            }
            const cleaned = new Request(request, { headers });
            const attemptFetch = countedFetch(network, this.stats);
            const retryRequest = cleaned.clone();
            let response = await adapter.execute(cleaned, state, {
              ...operation.context,
              fetch: attemptFetch,
            });
            if (response.status === 401) {
              attemptFetch.markFailure();
              const refreshed = await this.checkCredentials(network, {
                validate: false,
                forceRefresh: true,
              });
              if (
                refreshed.ok &&
                refreshed.value.valid &&
                this.state &&
                JSON.stringify(this.state.credentials) !== JSON.stringify(state.credentials) &&
                !this.stale(generation)
              ) {
                await response.body?.cancel();
                response = await adapter.execute(retryRequest, structuredClone(this.state), {
                  ...operation.context,
                  fetch: attemptFetch,
                });
              }
            }
            if (!response.ok) {
              attemptFetch.markFailure();
            }
            const changed = this.stale(generation);
            if (changed) {
              await response.body?.cancel();
              operation.finish();
              return errorResponse(changed.error, 401);
            }
            return ownResponse(
              response,
              operation.finish,
              operation.context.signal,
              attemptFetch.markFailure,
            );
          } catch (error) {
            operation.finish();
            throw error;
          }
        },
      }),
    );
  }

  async logout(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.generation++;
    this.revision++;
    this.refresh.clear();
    this.abortResources();
    this.state = null;
    this.restoreFailure = "missing-state";
    this.emit();
    const previous = [...new Set(this.adapters.values())];
    this.adapters.clear();
    await Promise.allSettled(previous.map((adapter) => adapter.close?.()));
  }
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.generation++;
    this.revision++;
    this.abortResources();
    this.listeners.clear();
    await Promise.allSettled(
      [...new Set(this.adapters.values())].map((adapter) => adapter.close?.()),
    );
    this.adapters.clear();
  }
}
