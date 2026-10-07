import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createProvider } from "../../src/providers/aistudio/index.js";
const context = { fetch: globalThis.fetch, signal: new AbortController().signal };
async function connectBrowser(url: string, token: string) {
  const ws = new WebSocket(url, { origin: "https://aistudio.google.com" });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => ws.send(JSON.stringify({ type: "auth", payload: { token } })));
    ws.once("message", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}
test("AI Studio owned authenticated relay discovers models and releases its listener", async () => {
  const adapter = createProvider();
  try {
    const connected = await adapter.connect({ kind: "relay" }, context);
    assert.equal(connected.ok, true);
    if (!connected.ok) {
      return;
    }
    const connection = adapter.getConnection!()!;
    const ws = await connectBrowser(connection.url, connection.token);
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "http_request") {
        assert.equal(
          message.payload.url,
          "https://generativelanguage.googleapis.com/v1beta/models",
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "http_response",
            payload: {
              status: 200,
              headers: {},
              body: JSON.stringify({
                models: [
                  { name: "models/gemini-test", supportedGenerationMethods: ["generateContent"] },
                ],
              }),
            },
          }),
        );
      }
    });
    const auth = await adapter.checkAuth(connected.value, context);
    assert.equal(auth.ok, true);
    const models = await adapter.listModels(connected.value, context);
    assert.equal(models.ok, true);
    if (models.ok) {
      assert.equal(models.value[0]?.id, "gemini-test");
    }
    await adapter.close!();
    assert.equal(adapter.getConnection!(), null);
    assert.equal((await adapter.getQuota(connected.value, context)).ok, true);
  } finally {
    await adapter.close!();
  }
});
test("AI Studio relay rejects unknown browser origins and wrong credentials", async () => {
  const adapter = createProvider();
  try {
    assert.equal((await adapter.connect({ kind: "relay" }, context)).ok, true);
    const connection = adapter.getConnection!()!;
    const wrong = new WebSocket(connection.url, { origin: "https://aistudio.google.com" });
    await new Promise<void>((resolve, reject) => {
      wrong.once("open", () =>
        wrong.send(JSON.stringify({ type: "auth", payload: { token: "bad" } })),
      );
      wrong.once("close", (code) => {
        assert.equal(code, 1008);
        resolve();
      });
      wrong.once("error", reject);
    });
    const hostile = new WebSocket(connection.url, { origin: "https://evil.example" });
    await new Promise<void>((resolve) => hostile.once("error", () => resolve()));
    assert.equal(
      (await adapter.connect({ kind: "relay", url: "wss://example.com" }, context)).ok,
      false,
    );
  } finally {
    await adapter.close!();
  }
});

test("AI Studio browser companion sends only fixed Google routes with browser credentials", async () => {
  const { connectAIStudioBrowser } = await import("../../src/providers/aistudio/browser-client.js");
  let socket: FakeSocket;
  class FakeSocket {
    readyState = 1;
    bufferedAmount = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void | Promise<void>) | null = null;
    onclose: (() => void) | null = null;
    sent: any[] = [];
    constructor() {
      socket = this;
    }
    send(value: string) {
      this.sent.push(JSON.parse(value));
    }
    close() {
      this.onclose?.();
    }
  }
  let calls = 0;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  let streamed: (() => void) | undefined;
  const stop = connectAIStudioBrowser(
    { url: "ws://127.0.0.1:1234/v1/ws", token: "secret" },
    {
      WebSocket: FakeSocket as unknown as typeof globalThis.WebSocket,
      fetch: async (input, init) => {
        calls++;
        assert.equal(init?.credentials, "include");
        assert.equal(init?.redirect, "error");
        if (String(input).includes(":streamGenerateContent")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
                controller.enqueue(new TextEncoder().encode('data: {"candidates":[]}\n\n'));
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return Response.json({ models: [] });
      },
    },
  );
  socket!.onopen!();
  assert.equal(socket!.sent[0].payload.token, "secret");
  await socket!.onmessage!({
    data: JSON.stringify({
      id: "one",
      type: "http_request",
      payload: { method: "GET", url: "https://generativelanguage.googleapis.com/v1beta/models" },
    }),
  });
  assert.equal(calls, 1);
  assert.equal(socket!.sent[1].type, "http_response");
  await socket!.onmessage!({
    data: JSON.stringify({
      id: "two",
      type: "http_request",
      payload: { method: "GET", url: "https://evil.example/" },
    }),
  });
  assert.equal(calls, 1);
  assert.equal(socket!.sent[2].type, "error");
  const firstChunk = new Promise<void>((resolve) => {
    streamed = resolve;
  });
  const originalSend = socket!.send.bind(socket!);
  socket!.send = (value: string) => {
    originalSend(value);
    if (JSON.parse(value).type === "stream_chunk") streamed!();
  };
  const streaming = socket!.onmessage!({
    data: JSON.stringify({
      id: "stream",
      type: "http_request",
      payload: {
        method: "POST",
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
        body: "{}",
      },
    }),
  });
  await firstChunk;
  assert.equal(socket!.sent.at(-2).type, "stream_start");
  assert.equal(socket!.sent.at(-1).type, "stream_chunk");
  streamController!.close();
  await streaming;
  assert.equal(socket!.sent.at(-1).type, "stream_end");
  stop();
});

test("AI Studio maps Gemini response to OpenAI chat and aborts active browser work", async () => {
  const adapter = createProvider();
  try {
    const connected = await adapter.connect({ kind: "relay" }, context);
    assert.ok(connected.ok);
    if (!connected.ok) {
      return;
    }
    const connection = adapter.getConnection!()!;
    const ws = await connectBrowser(connection.url, connection.token);
    let cancelled: (() => void) | undefined;
    let requestSent: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const sent = new Promise<void>((resolve) => {
      requestSent = resolve;
    });
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "cancel") {
        cancelled!();
      }
      if (message.type === "http_request") {
        if (message.payload.url.endsWith(":generateContent")) {
          assert.equal(JSON.parse(message.payload.body).stream, undefined);
          assert.equal(
            JSON.parse(message.payload.body).generationConfig.thinkingConfig.thinkingLevel,
            "LOW",
          );
          ws.send(
            JSON.stringify({
              id: message.id,
              type: "http_response",
              payload: {
                status: 200,
                headers: {},
                body: JSON.stringify({
                  candidates: [
                    {
                      content: { role: "model", parts: [{ text: "Hello" }] },
                      finishReason: "STOP",
                    },
                  ],
                }),
              },
            }),
          );
        } else {
          requestSent!();
        }
      }
    });
    const response = await adapter.execute(
      new Request("https://internal/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gemini-test",
          reasoning_effort: "low",
          messages: [{ role: "user", content: "Hi" }],
        }),
      }),
      connected.value,
      context,
    );
    const result = (await response.json()) as any;
    assert.equal(result.choices[0].message.content, "Hello");
    const abort = new AbortController();
    const models = adapter.listModels(connected.value, { ...context, signal: abort.signal });
    await sent;
    abort.abort();
    assert.equal((await models).ok, false);
    await cancellation;
  } finally {
    await adapter.close!();
  }
});

test("AI Studio discovers all model pages and omits non-generative models", async () => {
  const adapter = createProvider();
  try {
    const connected = await adapter.connect({ kind: "relay" }, context);
    assert.ok(connected.ok);
    const connection = adapter.getConnection!()!;
    const ws = await connectBrowser(connection.url, connection.token);
    let calls = 0;
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "http_request") return;
      calls++;
      const second = new URL(message.payload.url).searchParams.get("pageToken") === "next";
      ws.send(
        JSON.stringify({
          id: message.id,
          type: "http_response",
          payload: {
            status: 200,
            body: JSON.stringify({
              models: second
                ? [{ name: "models/two", supportedGenerationMethods: ["generateContent"] }]
                : [
                    { name: "models/one", supportedGenerationMethods: ["generateContent"] },
                    { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
                  ],
              ...(!second ? { nextPageToken: "next" } : {}),
            }),
          },
        }),
      );
    });
    const result = await adapter.listModels(connected.value, context);
    assert.ok(result.ok);
    assert.deepEqual(
      result.value.map((model) => model.id),
      ["one", "two"],
    );
    assert.equal(calls, 2);
  } finally {
    await adapter.close!();
  }
});
