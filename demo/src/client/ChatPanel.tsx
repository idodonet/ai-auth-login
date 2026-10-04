import type { PersistedTab, Model } from "../shared/types";
import { useState, useRef, useEffect } from "react";
export function Composer({
  enabled,
  streaming,
  send,
  stop,
}: {
  enabled: boolean;
  streaming: boolean;
  send: (text: string) => Promise<void>;
  stop: () => void;
}) {
  const [text, setText] = useState("");
  function submit() {
    if (enabled && !streaming && text.trim()) {
      void send(text);
      setText("");
    }
  }
  return (
    <div className="composer">
      <textarea
        aria-label="Message"
        placeholder="Write a message…"
        value={text}
        disabled={!enabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div>
        <small>Enter to send · Shift + Enter for a new line</small>
        {streaming ? (
          <button className="primary" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="primary" disabled={!enabled || !text.trim()} onClick={submit}>
            Send ↑
          </button>
        )}
      </div>
    </div>
  );
}

export function ChatPanel({
  tab,
  models,
  streaming,
  enabled,
  selectModel,
  clear,
  send,
  stop,
}: {
  tab: PersistedTab;
  models: readonly Model[];
  streaming: boolean;
  enabled: boolean;
  selectModel: (model: string | null) => void;
  clear: () => void;
  send: (text: string) => Promise<void>;
  stop: () => void;
}) {
  const messageList = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const element = messageList.current;
    if (element && follow.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [tab.messages]);
  return (
    <>
      <div className="chat-header">
        <h2>Conversation</h2>
        <label>
          Model
          {models.length ? (
            <select
              value={tab.model ?? ""}
              onChange={(event) => selectModel(event.target.value || null)}
            >
              <option value="">Choose a model</option>
              {models.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
          ) : (
            <input
              placeholder="Enter model ID"
              value={tab.model ?? ""}
              onChange={(event) => selectModel(event.target.value || null)}
            />
          )}
        </label>
        <button disabled={streaming || !tab.messages.length} onClick={() => clear()}>
          Clear
        </button>
      </div>
      <div
        className="messages"
        aria-live="polite"
        ref={messageList}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {!tab.messages.length && (
          <div className="empty">
            <div className="spark">✳</div>
            <h3>A fresh conversation</h3>
            <p>Connect an account and pick a model to begin.</p>
          </div>
        )}
        {tab.messages.map((message) => (
          <article className={`message ${message.role}`} key={message.id}>
            <span className="message-label">
              {message.role === "user" ? "YOU" : "ASSISTANT"}{" "}
              {message.status && message.status !== "complete" && <em>{message.status}</em>}
            </span>
            <div>
              {message.content ||
                (message.status === "streaming" ? "Thinking…" : "No response text.")}
            </div>
          </article>
        ))}
      </div>
      <Composer key={tab.id} enabled={enabled} streaming={streaming} send={send} stop={stop} />
    </>
  );
}
