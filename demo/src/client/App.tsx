import { loadTheme, saveTheme, type Theme } from "./theme";
import { useEffect, useRef, useState } from "react";
import type {
  PersistedApp,
  PersistedTab,
  ProviderDescriptor,
  SessionView,
  TabAction,
} from "../shared/types";
import { action, bootstrap, chat, events, relayHelper } from "./api";
import { createTab, loadState, saveState } from "./storage";
import { chatContext, MAX_CHAT_MESSAGES } from "../shared/chat";
import { SessionTabs } from "./SessionTabs";
import { AccountPanel } from "./AccountPanel";
import { ChatPanel } from "./ChatPanel";
import { ConnectionPanel } from "./ConnectionPanel";
import "./style.css";

const initial = loadState();
export default function App() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveTheme(theme);
  }, [theme]);
  const [app, setApp] = useState(initial.state);
  const current = useRef(app);
  const [storageError, setStorageError] = useState(initial.error);
  const storageBlocked = useRef(Boolean(initial.error));
  const [providers, setProviders] = useState<readonly ProviderDescriptor[]>([]);
  const [sessions, setSessions] = useState<Record<string, SessionView>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [online, setOnline] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const streams = useRef(new Map<string, AbortController>());
  const [now, setNow] = useState(Date.now());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function update(fn: (state: PersistedApp) => PersistedApp, deferred = false) {
    const next = fn(current.current);
    current.current = next;
    setApp(next);
    if (storageBlocked.current) {
      return;
    }
    if (deferred) {
      if (!saveTimer.current) {
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null;
          setStorageError(saveState(current.current));
        }, 350);
      }
    } else {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
      saveTimer.current = null;
      setStorageError(saveState(next));
    }
  }
  useEffect(() => {
    function flush() {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
      saveTimer.current = null;
      if (!storageBlocked.current) {
        setStorageError(saveState(current.current));
      }
    }
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
      saveTimer.current = null;
    };
  }, []);
  function patch(id: string, values: Partial<PersistedTab>) {
    update((state) => ({
      ...state,
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...values } : tab)),
    }));
  }
  function receive(session: SessionView) {
    setSessions((state) => ({ ...state, [session.id]: session }));
    patch(session.id, {
      ...(!session.sdkState &&
      !session.auth.valid &&
      (session.auth.reason === "invalid-state" ||
        session.auth.reason === "unsupported-state-version")
        ? {}
        : { sdkState: session.sdkState }),
      ...(session.provider ? { provider: session.provider } : {}),
    });
  }
  function fail(id: string, error: unknown) {
    setErrors((state) => ({
      ...state,
      [id]: error instanceof Error ? error.message : String(error),
    }));
  }
  async function run(id: string, operation: TabAction, clearError = true) {
    setBusy((state) => ({ ...state, [id]: true }));
    if (clearError) {
      setErrors((state) => ({ ...state, [id]: "" }));
    }
    try {
      const session = await action(id, operation);
      receive(session);
      return session;
    } catch (error) {
      fail(id, error);
    } finally {
      setBusy((state) => ({ ...state, [id]: false }));
    }
  }
  useEffect(() => {
    setOnline(false);
    const abort = new AbortController();
    let disposed = false;
    void (async () => {
      try {
        const data = await bootstrap();
        if (disposed) {
          return;
        }
        setErrors((state) => ({ ...state, global: "" }));
        setProviders(data.providers);
        // Subscribe before restoration so rotated credentials are saved immediately.
        void events(abort.signal, (event) => {
          if (disposed) {
            return;
          }
          if (event.type === "state") {
            patch(event.tabId, { sdkState: event.state });
          } else {
            receive(event.session);
          }
        }).catch((error) => {
          if (!abort.signal.aborted) {
            setOnline(false);
            fail("global", error);
          }
        });
        await Promise.all(
          current.current.tabs.map((tab) =>
            run(tab.id, {
              type: "restore",
              ...(tab.sdkState ? { state: tab.sdkState } : {}),
            }),
          ),
        );
        if (!disposed) {
          setOnline(true);
        }
      } catch (error) {
        if (!disposed) {
          fail("global", error);
        }
      }
    })();
    return () => {
      disposed = true;
      abort.abort();
      for (const stream of streams.current.values()) {
        stream.abort();
      }
    };
  }, [epoch]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const tab = app.tabs.find((item) => item.id === app.activeTabId) ?? app.tabs[0];
  const session = sessions[tab.id];
  const descriptor = providers.find((provider) => provider.id === tab.provider);
  function stop(id: string) {
    streams.current.get(id)?.abort();
  }
  async function switchProvider(value: string) {
    stop(tab.id);
    const loggedOut = await run(tab.id, { type: "logout" });
    if (!loggedOut) {
      return;
    }
    patch(tab.id, {
      provider: (value || null) as PersistedTab["provider"],
      model: null,
    });
  }
  async function send(content: string) {
    if (!content.trim() || !session?.auth.valid || !tab.model || streams.current.has(tab.id)) {
      return;
    }
    const id = tab.id;
    const assistantId = crypto.randomUUID();
    const messages = [
      ...tab.messages,
      {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: content.trim(),
      },
      {
        id: assistantId,
        role: "assistant" as const,
        content: "",
        status: "streaming" as const,
      },
    ];
    patch(id, { messages });
    const controller = new AbortController();
    streams.current.set(id, controller);
    const alter = (text: string, status?: "complete" | "stopped" | "error") =>
      update(
        (state) => ({
          ...state,
          tabs: state.tabs.map((item) =>
            item.id !== id
              ? item
              : {
                  ...item,
                  messages: item.messages.map((message) =>
                    message.id === assistantId
                      ? {
                          ...message,
                          content: message.content + text,
                          ...(status ? { status } : {}),
                        }
                      : message,
                  ),
                },
          ),
        }),
        !status,
      );
    try {
      await chat(
        id,
        {
          model: tab.model,
          messages: chatContext(messages.slice(0, -1)),
        },
        controller.signal,
        (event) => {
          if (event.type === "delta") {
            alter(event.text);
          } else if (event.type === "error") {
            alter("", "error");
            fail(id, event.message);
          } else {
            alter("", "complete");
          }
        },
      );
    } catch (error) {
      alter("", controller.signal.aborted ? "stopped" : "error");
      if (!controller.signal.aborted) {
        fail(id, error);
      }
    } finally {
      streams.current.delete(id);
      if (
        !controller.signal.aborted &&
        current.current.tabs.some((item) => item.id === id && item.provider === tab.provider)
      ) {
        void run(id, { type: "refresh" }, false);
      }
    }
  }
  return (
    <div className="shell">
      <header>
        <a className="brand" href="/">
          ai-auth-login <span>PLAYGROUND</span>
        </a>
        <div className="header-controls">
          <span className="local">● Local workspace</span>
          <label className="theme-control">
            Theme
            <select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
      </header>
      <SessionTabs
        tabs={app.tabs}
        activeId={tab.id}
        providers={providers}
        select={(id) => update((state) => ({ ...state, activeTabId: id }))}
        close={(id) => {
          stop(id);
          void action(id, { type: "close" }).catch((error) => fail("global", error));
          update((state) => {
            const tabs = state.tabs.filter((item) => item.id !== id);
            if (!tabs.length) {
              const added = createTab();
              tabs.push(added);
              void run(added.id, { type: "restore" });
            }
            return {
              ...state,
              tabs,
              activeTabId: state.activeTabId === id ? tabs[0].id : state.activeTabId,
            };
          });
        }}
        add={() => {
          const added = createTab();
          update((state) => ({
            ...state,
            activeTabId: added.id,
            tabs: [...state.tabs, added],
          }));
          void run(added.id, { type: "restore" });
        }}
      />
      {storageError && (
        <div className="error" role="alert">
          {storageError}{" "}
          <button
            onClick={() => {
              storageBlocked.current = false;
              setStorageError(saveState(current.current));
            }}
          >
            Replace saved data
          </button>
        </div>
      )}
      {errors.global && (
        <div className="error" role="alert">
          {errors.global} <button onClick={() => setEpoch((value) => value + 1)}>Reconnect</button>
        </div>
      )}
      <main>
        <section className="workspace">
          <div className="heading">
            <div>
              <span className="eyebrow">ONE SDK. YOUR ACCOUNT.</span>
              <h1>Connect. Choose. Chat.</h1>
              <p>Try your provider through the same interface.</p>
            </div>
            <span className={session?.auth.valid ? "badge connected" : "badge"}>
              {session?.auth.valid ? "Connected" : "Awaiting connection"}
            </span>
          </div>
          <div className="connection-bar">
            <label>
              Provider
              <select
                value={tab.provider ?? ""}
                onChange={(event) => void switchProvider(event.target.value)}
                disabled={busy[tab.id]}
              >
                <option value="">Choose a provider</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
            {session?.auth.valid && (
              <button
                onClick={() => {
                  stop(tab.id);
                  void run(tab.id, { type: "logout" });
                }}
              >
                Log out
              </button>
            )}
          </div>
          {errors[tab.id] && (
            <div className="error" role="alert">
              {errors[tab.id]}
            </div>
          )}
          {tab.sdkState &&
            session &&
            !session.auth.valid &&
            session.auth.reason !== "missing-state" && (
              <p className="warning" role="status">
                {session.auth.reason === "unsupported-state-version"
                  ? "This saved login was created by another SDK version. Use a matching version or connect again to replace it. Your saved login has been kept."
                  : session.auth.reason === "invalid-state"
                    ? "This saved login could not be restored. Connect again to replace it. Your saved login has been kept."
                    : "Your saved login needs to be renewed. Connect again to continue."}
              </p>
            )}
          {session?.warnings.map((warning, index) => (
            <p className="warning" key={index}>
              {warning}
            </p>
          ))}
          {descriptor && !session?.auth.valid && (
            <ConnectionPanel
              key={`${tab.id}:${tab.provider}`}
              descriptor={descriptor}
              session={session}
              busy={busy[tab.id]}
              run={(operation) => run(tab.id, operation)}
            />
          )}
          {session?.connection && <Relay connection={session.connection} />}
          {tab.messages.length >= MAX_CHAT_MESSAGES && (
            <p className="warning" role="status">
              Replies use the latest {MAX_CHAT_MESSAGES} messages or fewer, starting with a user
              message. Your full conversation stays saved in this browser.
            </p>
          )}
          <ChatPanel
            key={tab.id}
            tab={tab}
            models={session?.models ?? []}
            enabled={online && Boolean(session?.auth.valid && tab.model)}
            streaming={streams.current.has(tab.id)}
            selectModel={(model) => patch(tab.id, { model })}
            clear={() => patch(tab.id, { messages: [] })}
            send={send}
            stop={() => stop(tab.id)}
          />
        </section>
        <AccountPanel
          session={session}
          now={now}
          busy={busy[tab.id]}
          online={online}
          refresh={() => void run(tab.id, { type: "refresh" })}
        />
      </main>
      <footer>
        Built with ai-auth-login <span>Provider capabilities come directly from the SDK.</span>
      </footer>
    </div>
  );
}
function Relay({ connection }: { connection: { url: string; token: string } }) {
  const [copied, setCopied] = useState(false);
  const [snippet, setSnippet] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void relayHelper()
      .then((source) => {
        if (active) {
          setSnippet(
            `(() => {\n${source}\nconnectAIStudioBrowser(${JSON.stringify(connection)});\n})();`,
          );
        }
      })
      .catch((error) => {
        if (active) {
          setError(String(error));
        }
      });
    return () => {
      active = false;
    };
  }, [connection.url, connection.token]);
  return (
    <details className="relay">
      <summary>AI Studio relay setup</summary>
      <p>
        <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer">
          Open AI Studio ↗
        </a>
        , sign in, and paste this snippet into its browser developer console. Keep this connection
        token private. After pasting, click Refresh account to finish connecting.
      </p>
      <p role="alert">{error}</p>
      <button
        disabled={!snippet}
        onClick={() =>
          void navigator.clipboard
            .writeText(snippet)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
      >
        {copied ? "Copied" : "Copy setup snippet"}
      </button>
      <pre>{snippet}</pre>
    </details>
  );
}
