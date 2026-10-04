import type { ChatRequest } from "./types.js";

export const MAX_CHAT_MESSAGES = 200;

/** Keep a recent context window starting with a user message. */
export function chatContext(messages: ChatRequest["messages"]): ChatRequest["messages"] {
  const start = Math.max(0, messages.length - MAX_CHAT_MESSAGES);
  const firstUser = messages.findIndex(
    (message, index) => index >= start && message.role === "user",
  );
  return messages
    .slice(firstUser < 0 ? start : firstUser)
    .map(({ role, content }) => ({ role, content }));
}
