import assert from "node:assert/strict";
import test from "node:test";
import { executeAnthropic } from "../src/protocols/anthropic.js";
import { executeGemini, executeInteractions } from "../src/protocols/gemini.js";

function request(path = "chat/completions") {
  return new Request(`https://internal/v1/${path}`, {
    method: "POST",
    body: JSON.stringify({
      model: "test",
      stream: true,
      ...(path === "responses" ? { input: "hello" } : { messages: [] }),
    }),
  });
}
function sse(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

for (const [name, execute, delta] of [
  [
    "Anthropic",
    executeAnthropic,
    { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
  ],
  ["Gemini", executeGemini, { candidates: [{ content: { parts: [{ text: "partial" }] } }] }],
  ["Interactions", executeInteractions, { event_type: "step.delta", delta: { text: "partial" } }],
] as const) {
  for (const path of ["chat/completions", "responses"]) {
    test(`${name} ${path} rejects empty and partial native stream EOF`, async () => {
      for (const events of [[], [delta]]) {
        const response = await execute(request(path), async () => sse(events));
        await assert.rejects(response.text(), /ended before completion/);
      }
    });
  }
}

test("Gemini streaming prompt block becomes an error in Chat and Responses", async () => {
  for (const path of ["chat/completions", "responses"]) {
    const response = await executeGemini(request(path), async () =>
      sse([{ promptFeedback: { blockReason: "SAFETY" } }]),
    );
    const output = await response.text();
    assert.match(output, /content_filter/);
    assert.match(output, /SAFETY/);
    assert.doesNotMatch(output, /response.completed|\[DONE\]/);
  }
});

test("Anthropic native errors terminate without a success marker", async () => {
  const response = await executeAnthropic(request(), async () =>
    sse([{ type: "error", error: { message: "overloaded" } }]),
  );
  const output = await response.text();
  assert.match(output, /overloaded/);
  assert.doesNotMatch(output, /\[DONE\]/);
});

test("Anthropic rejects malformed nonstream upstream completions with 502", async () => {
  for (const payload of [
    { unexpected: "proxy error" },
    null,
    { content: "wrong type", stop_reason: "end_turn" },
    { content: [null], stop_reason: "end_turn" },
    { content: [{ type: "text" }], stop_reason: "end_turn" },
  ]) {
    const input = new Request("https://internal/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "test", messages: [] }),
    });
    const response = await executeAnthropic(input, async () => Response.json(payload));
    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /Invalid upstream Anthropic/);
  }
  const input = new Request("https://internal/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "test", messages: [] }),
  });
  const response = await executeAnthropic(input, async () => new Response("not JSON"));
  assert.equal(response.status, 502);
});
