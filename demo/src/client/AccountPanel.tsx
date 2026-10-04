import { useState, useEffect } from "react";
import type { SessionView } from "../shared/types";
export function AccountPanel({
  session,
  now,
  busy,
  online,
  refresh,
}: {
  session?: SessionView;
  now: number;
  busy?: boolean;
  online: boolean;
  refresh: () => void;
}) {
  const [expanded, setExpanded] = useState(window.innerWidth > 760);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 761px)");
    const change = () => setExpanded(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return (
    <aside>
      <details
        className="account-details"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>Account & usage</summary>
        <span className="eyebrow">CONNECTION DETAILS</span>
        <h2>Your account</h2>
        <dl>
          <dt>Account ID</dt>
          <dd>{session?.account?.id ?? "Unknown"}</dd>
          <dt>Free account</dt>
          <dd>
            {session?.account?.isFree === null || session?.account?.isFree === undefined
              ? "Unknown"
              : session.account.isFree
                ? "Yes"
                : "No"}
          </dd>
          <dt>Email</dt>
          <dd>{session?.account?.email ?? "Unknown"}</dd>
          <dt>Plan</dt>
          <dd>{session?.account?.plan ?? "Unknown"}</dd>
          <dt>Last authenticated</dt>
          <dd>
            {session?.account?.lastAuthenticatedAt
              ? new Date(session.account.lastAuthenticatedAt).toLocaleString()
              : "Unknown"}
          </dd>
        </dl>
        <div className="divider" />
        <h2>Usage & quota</h2>
        {!session?.quota ? (
          <p>Not checked</p>
        ) : !session.quota.supported ? (
          <p>Quota reporting unsupported</p>
        ) : !session.quota.windows.length ? (
          <p>No quota windows reported</p>
        ) : (
          session.quota.windows.map((window, index) => (
            <div className="quota" key={index}>
              <strong>{window.name}</strong>
              <span>
                {window.remainingPercent !== null
                  ? `${window.remainingPercent}% remaining`
                  : window.remaining !== null
                    ? `${window.remaining}${window.limit !== null ? ` / ${window.limit}` : ""} ${window.unit ?? ""} remaining`
                    : "Remaining unknown"}
              </span>
              {window.remainingPercent !== null && (
                <progress
                  aria-label={`${window.name} remaining quota`}
                  max="100"
                  value={window.remainingPercent}
                />
              )}
              {window.model && <small>{window.model}</small>}
              <small>
                {window.resetsAt
                  ? `Resets in ${duration(Date.parse(window.resetsAt) - now)}`
                  : "Reset time unknown"}
              </small>
            </div>
          ))
        )}
        <button className="refresh" disabled={busy || !online} onClick={refresh}>
          ↻ Refresh account
        </button>
        <div className="divider" />
        <h2>This session</h2>
        <dl>
          <dt>Requests sent</dt>
          <dd>{session?.stats.requestsSent ?? 0}</dd>
          <dt>Requests failed</dt>
          <dd>{session?.stats.requestsFailed ?? 0}</dd>
          <dt>Started</dt>
          <dd>
            {session?.stats.startedAt ? new Date(session.stats.startedAt).toLocaleString() : "—"}
          </dd>
        </dl>
        <p className="privacy">
          Credentials stay in this local demo server. Saved sessions in this browser contain
          secrets.
        </p>
      </details>
    </aside>
  );
}
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
}
