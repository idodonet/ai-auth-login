import assert from "node:assert/strict";
import test from "node:test";
import { chat, events } from "../src/client/api.js";
import type { ChatEvent } from "../src/shared/types.js";

test("chat parser handles byte splits, final lines, and terminal errors; rejects truncated EOF", async (t) => {
  const encoder = new TextEncoder();
  let chunks: Uint8Array[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        }),
      ),
  );
  const received: ChatEvent[] = [];
  const run = () =>
    chat(
      "tab",
      { model: "demo-chat", messages: [{ role: "user", content: "Hello" }] },
      new AbortController().signal,
      (event) => received.push(event),
    );
  const bytes = encoder.encode('{"type":"delta","text":"שלום"}\r\n{"type":"done"}');
  chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
  await run();
  assert.deepEqual(received, [{ type: "delta", text: "שלום" }, { type: "done" }]);
  received.length = 0;
  chunks = [encoder.encode('{"type":"error","message":"Rate limited"}\n{"type":"done"}\n')];
  await run();
  assert.deepEqual(received, [{ type: "error", message: "Rate limited" }]);
  chunks = [encoder.encode('{"type":"delta","text":"partial"}\n')];
  await assert.rejects(run(), /ended before completion/);
  chunks = [];
  await assert.rejects(run(), /ended before completion/);
});

test("session feed EOF reaches reconnect handler, while cancellation stays quiet", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(': connected\n\ndata: {"type":"state","tabId":"tab","state":null}\n\n'),
  );
  const received: unknown[] = [];
  await assert.rejects(
    events(new AbortController().signal, (event) => received.push(event)),
    /session connection closed/,
  );
  assert.deepEqual(received, [{ type: "state", tabId: "tab", state: null }]);
  const cancelled = new AbortController();
  cancelled.abort();
  await events(cancelled.signal, () => assert.fail("Cancelled feed must not deliver events"));
});
