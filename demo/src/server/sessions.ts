import { ProviderSession, type AuthSession, type Result } from "ai-auth-login";
import type {
  ChatEvent,
  ChatRequest,
  SessionEvent,
  SessionView,
  TabAction,
} from "../shared/types.js";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const failure = (message: string): Result<never> => ({
  ok: false,
  error: { code: "provider-error", message, retryable: false },
});
interface Tab {
  sdk: ProviderSession;
  login: AuthSession | null;
  view: SessionView;
  busy: boolean;
  chat: AbortController | null;
  revision: number;
}

export class SessionManager {
  private tabs = new Map<string, Tab>();
  constructor(
    private emit: (event: SessionEvent) => void,
    private factory = (state?: string) => new ProviderSession({ state }),
  ) {}

  private create(id: string, state?: string): Tab {
    const sdk = this.factory(state);
    const tab: Tab = {
      sdk,
      login: null,
      busy: false,
      chat: null,
      revision: 0,
      view: {
        id,
        provider: sdk.provider,
        sdkState: sdk.exportState(),
        auth: { valid: false, reason: "missing-state" },
        login: null,
        account: null,
        quota: null,
        models: [],
        stats: sdk.getStats(),
        connection: null,
        warnings: [],
      },
    };
    sdk.onStateChange((state) => {
      if (this.tabs.get(id) !== tab) {
        return;
      }
      tab.view.sdkState = state;
      this.emit({ type: "state", tabId: id, state });
    });
    this.tabs.set(id, tab);
    return tab;
  }

  private snapshot(tab: Tab): SessionView {
    const login = tab.login;
    return {
      ...tab.view,
      provider: tab.sdk.provider,
      sdkState: tab.sdk.exportState(),
      stats: tab.sdk.getStats(),
      connection: tab.sdk.getConnection(),
      login: login
        ? {
            kind: login.kind,
            url: login.url,
            expiresAt: login.expiresAt,
            userCode: login.kind === "device" ? login.userCode : null,
          }
        : null,
    };
  }
  private publish(tab: Tab): SessionView {
    const view = this.snapshot(tab);
    if (this.tabs.get(view.id) === tab) {
      this.emit({ type: "session", tabId: view.id, session: view });
    }
    return view;
  }
  snapshots(): SessionView[] {
    return [...this.tabs.values()].map((tab) => this.snapshot(tab));
  }

  private async refresh(tab: Tab): Promise<void> {
    const revision = tab.revision;
    const current = () => this.tabs.get(tab.view.id) === tab && tab.revision === revision;
    tab.view.warnings = [];
    const checked = await tab.sdk.checkAuth();
    if (!current()) {
      return;
    }
    if (!checked.ok) {
      tab.view.auth = { valid: false, reason: "reauth-required" };
      tab.view.warnings.push(`Authentication: ${checked.error.message}`);
      return;
    }
    tab.view.auth = checked.value;
    if (!checked.value.valid) {
      return;
    }
    const [account, quota, models] = await Promise.all([
      tab.sdk.getAccount(),
      tab.sdk.getQuota(),
      tab.sdk.listModels(),
    ]);
    if (!current()) {
      return;
    }
    if (account.ok) {
      tab.view.account = account.value;
    } else {
      tab.view.warnings.push(`Account: ${account.error.message}`);
    }
    if (quota.ok) {
      tab.view.quota = quota.value;
    } else {
      tab.view.warnings.push(`Quota: ${quota.error.message}`);
    }
    if (models.ok) {
      tab.view.models = models.value;
    } else {
      tab.view.warnings.push(`Models: ${models.error.message}`);
    }
  }

  async action(id: string, action: TabAction): Promise<Result<SessionView>> {
    let tab = this.tabs.get(id);
    if (action.type === "restore") {
      if (tab && (action.state === undefined || tab.sdk.exportState() === action.state)) {
        return ok(this.publish(tab));
      }
      if (tab) {
        tab.revision++;
        this.tabs.delete(id);
        tab.chat?.abort();
        tab.login?.cancel();
        await tab.sdk.close();
      }
      tab = this.create(id, action.state);
    } else if (!tab) {
      tab = this.create(id);
    }
    if (action.type === "cancel-auth") {
      tab.revision++;
      tab.login?.cancel();
      tab.login = null;
      return ok(this.publish(tab));
    }
    if (action.type === "close" || action.type === "logout") {
      tab.revision++;
      tab.chat?.abort();
      tab.login?.cancel();
      tab.login = null;
      if (action.type === "close") {
        const view = this.snapshot(tab);
        this.tabs.delete(id);
        await tab.sdk.close();
        return ok(view);
      }
      await tab.sdk.logout();
      tab.view.auth = { valid: false, reason: "missing-state" };
      tab.view.account = null;
      tab.view.models = [];
      tab.view.quota = null;
      tab.view.warnings = [];
      return ok(this.publish(tab));
    }
    if (tab.busy) {
      return failure("Another session operation is in progress.");
    }
    const revision = ++tab.revision;
    tab.busy = true;
    try {
      let result: Result<unknown> = ok(undefined);
      if (action.type === "begin-auth") {
        tab.login?.cancel();
        tab.login = null;
        const started = await tab.sdk.beginAuth(action.provider, {
          method: action.method,
        });
        if (started.ok && revision === tab.revision) {
          tab.login = started.value;
        } else if (started.ok) {
          started.value.cancel();
        }
        result = started;
      } else if (action.type === "complete-auth" || action.type === "wait-auth") {
        const login = tab.login;
        if (
          !login ||
          (action.type === "complete-auth" ? login.kind !== "callback" : login.kind !== "device")
        ) {
          return failure("Start the matching login first.");
        }
        result =
          login.kind === "callback" && action.type === "complete-auth"
            ? await login.complete(action.callbackURL)
            : login.kind === "device"
              ? await login.wait()
              : failure("Invalid login method.");
        if (result.ok && tab.login === login) {
          tab.login = null;
        }
      } else if (action.type === "connect") {
        tab.chat?.abort();
        result = await tab.sdk.connect(action.provider, action.credentials);
      }
      if (!result.ok) {
        this.publish(tab);
        return result;
      }
      if (revision !== tab.revision || this.tabs.get(id) !== tab) {
        return failure("Session operation was cancelled.");
      }
      if (action.type !== "begin-auth") {
        await this.refresh(tab);
      }
      return ok(this.publish(tab));
    } catch {
      return failure("Session operation failed.");
    } finally {
      tab.busy = false;
    }
  }

  async chat(
    id: string,
    request: ChatRequest,
    signal: AbortSignal,
    emit: (event: ChatEvent) => Promise<void>,
  ): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) {
      await emit({ type: "error", message: "Restore this tab first." });
      return;
    }
    if (tab.chat) {
      await emit({
        type: "error",
        message: "A response is already running in this tab.",
      });
      return;
    }
    const controller = new AbortController();
    tab.chat = controller;
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      const created = await tab.sdk.createSDK({
        maxRetries: 0,
        timeout: 120_000,
      });
      if (!created.ok) {
        await emit({ type: "error", message: created.error.message });
        return;
      }
      combined.throwIfAborted();
      const stream = await created.value.chat.completions.create(
        { model: request.model, messages: request.messages, stream: true },
        { signal: combined },
      );
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta.content;
        if (text) {
          await emit({ type: "delta", text });
        }
      }
      await emit({ type: "done" });
    } catch (error) {
      if (!combined.aborted) {
        const status =
          typeof error === "object" && error !== null && "status" in error ? error.status : null;
        const message =
          status === 429
            ? "Provider rate limit reached. Wait before retrying."
            : status === 401 || status === 403
              ? "Provider rejected this login or model access. Refresh or sign in again."
              : "Provider request failed. Check the login, model, and upstream connection.";
        await emit({ type: "error", message });
      }
    } finally {
      if (tab.chat === controller) {
        tab.chat = null;
      }
      this.publish(tab);
    }
  }
  async close(): Promise<void> {
    const tabs = [...this.tabs.values()];
    this.tabs.clear();
    for (const tab of tabs) {
      tab.chat?.abort();
      tab.login?.cancel();
    }
    await Promise.allSettled(tabs.map((tab) => tab.sdk.close()));
  }
}
