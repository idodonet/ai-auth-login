import assert from "node:assert/strict";
import test from "node:test";
import { chatContext, MAX_CHAT_MESSAGES } from "../src/shared/chat.js";
import { validChat } from "../src/server/validation.js";
import type { ChatRequest } from "../src/shared/types.js";

test("long conversations retain saved history while sending valid recent user-first context", () => {
  const messages: ChatRequest["messages"] = Array.from({ length: 401 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: String(index),
  }));
  const before = structuredClone(messages);
  const context = chatContext(messages);
  assert.equal(validChat({ model: "demo", messages }), false);
  assert.equal(validChat({ model: "demo", messages: context }), true);
  assert.equal(context[0]!.role, "user");
  assert.equal(context[0]!.content, "202");
  assert.equal(context.at(-1)!.content, "400");
  assert.ok(context.length <= MAX_CHAT_MESSAGES);
  assert.deepEqual(messages, before);
});

test("short conversations send all messages", () => {
  const messages: ChatRequest["messages"] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "follow up" },
  ];
  assert.deepEqual(chatContext(messages), messages);
});
