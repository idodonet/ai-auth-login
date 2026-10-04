import { useState } from "react";
import type { AuthMethod, ProviderDescriptor, SessionView, TabAction } from "../shared/types";
export function ConnectionPanel({
  descriptor,
  session,
  busy,
  run,
}: {
  descriptor: ProviderDescriptor;
  session?: SessionView;
  busy?: boolean;
  run: (operation: TabAction) => Promise<SessionView | undefined>;
}) {
  const [method, setMethod] = useState<AuthMethod>(descriptor.authMethods[0]);
  const [key, setKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [project, setProject] = useState("");
  const [location, setLocation] = useState("us-central1");
  const [callback, setCallback] = useState("");
  return (
    <div className="auth">
      <h2>Connect {descriptor.name}</h2>
      <p>Choose a supported connection method.</p>
      <label>
        Connection method
        <select
          value={method}
          disabled={Boolean(session?.login)}
          onChange={(event) => setMethod(event.target.value as AuthMethod)}
        >
          {descriptor.authMethods.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      {session?.login ? (
        <>
          <a className="button" target="_blank" rel="noreferrer" href={session.login.url}>
            Open login page ↗
          </a>
          {session.login.userCode && (
            <p>
              Device code: <strong>{session.login.userCode}</strong>
            </p>
          )}
          <small>Expires {new Date(session.login.expiresAt).toLocaleTimeString()}</small>
          {session.login.kind === "callback" ? (
            <>
              <label>
                Full callback URL
                <input
                  value={callback}
                  onChange={(event) => setCallback(event.target.value)}
                  placeholder="Paste the complete redirected URL"
                />
              </label>
              <button
                className="primary"
                disabled={busy || !callback}
                onClick={() => void run({ type: "complete-auth", callbackURL: callback })}
              >
                Complete login
              </button>
            </>
          ) : (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void run({ type: "wait-auth" })}
            >
              {busy ? "Waiting for approval…" : "Wait for approval"}
            </button>
          )}
          <button onClick={() => void run({ type: "cancel-auth" })}>Cancel login</button>
        </>
      ) : (
        <>
          {(method === "api-key" || method === "service-account") && (
            <>
              <label>
                {method === "api-key" ? "API key" : "Service account JSON"}
                {method === "api-key" ? (
                  <input
                    type="password"
                    value={key}
                    autoComplete="off"
                    onChange={(event) => setKey(event.target.value)}
                  />
                ) : (
                  <textarea value={key} onChange={(event) => setKey(event.target.value)} />
                )}
              </label>
              {descriptor.id === "openai-compatibility" && (
                <label>
                  Base URL
                  <input
                    type="url"
                    placeholder="https://example.com/v1"
                    value={baseURL}
                    onChange={(event) => setBaseURL(event.target.value)}
                  />
                </label>
              )}
              {descriptor.id === "vertex" && (
                <div className="fields">
                  <label>
                    Project
                    <input value={project} onChange={(event) => setProject(event.target.value)} />
                  </label>
                  <label>
                    Location
                    <input value={location} onChange={(event) => setLocation(event.target.value)} />
                  </label>
                </div>
              )}
            </>
          )}
          <button
            className="primary"
            disabled={
              busy ||
              ((method === "api-key" || method === "service-account") && !key.trim()) ||
              (descriptor.id === "openai-compatibility" && !baseURL.trim())
            }
            onClick={() => {
              if (method === "callback" || method === "device") {
                void run({
                  type: "begin-auth",
                  provider: descriptor.id,
                  method,
                });
              } else {
                void run({
                  type: "connect",
                  provider: descriptor.id,
                  credentials:
                    method === "relay"
                      ? { kind: "relay" }
                      : method === "service-account"
                        ? {
                            kind: "service-account",
                            serviceAccount: key,
                            project: project || undefined,
                            location,
                          }
                        : {
                            kind: "api-key",
                            apiKey: key,
                            baseURL: baseURL || undefined,
                            project: project || undefined,
                            location: descriptor.id === "vertex" ? location : undefined,
                          },
                }).then((result) => {
                  if (result?.auth.valid) {
                    setKey("");
                  }
                });
              }
            }}
          >
            {busy ? "Connecting…" : method === "relay" ? "Create relay connection" : "Connect"}
          </button>
        </>
      )}
    </div>
  );
}
