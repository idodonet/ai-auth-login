import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { ProviderSession } from "../src/session.js";
import { encodeState } from "../src/state.js";
import { getProvider } from "../src/providers/registry.js";
import type { Provider } from "../src/types.js";
import type { CredentialState, ProviderContext } from "../src/providers/contract.js";
import { executeAnthropic } from "../src/protocols/anthropic.js";
import { executeGemini, collectGeminiStream } from "../src/protocols/gemini.js";
import {
  chatCompletionToResponse,
  responsesToChat,
  chatToResponses,
  responseToChatCompletion,
} from "../src/protocols/responses.js";
import { parseSSE, encodeSSE } from "../src/protocols/sse.js";
import { unseal, compactionPrefix } from "../src/protocols/capsules.js";

const request = (path: string, body: unknown) =>
  new Request(`https://fixture${path}`, { method: "POST", body: JSON.stringify(body) });
const state = (provider: Provider): CredentialState => ({
  provider,
  authenticatedAt: null,
  credentials: {
    apiKey: "fixture",
    sessionToken: "fixture",
    accessToken: "fixture",
    access_token: "fixture",
    project: "project",
    location: "us-central1",
    expiresAt:
      provider === "antigravity"
        ? new Date(Date.now() + 3600000).toISOString()
        : Date.now() + 3600000,
  },
});
const context = (fetch: typeof globalThis.fetch): ProviderContext => ({
  fetch,
  signal: new AbortController().signal,
});
const chat = { model: "m", messages: [{ role: "user" as const, content: "hello" }] };
function sse(values: unknown[]): Response {
  const bytes = new TextEncoder().encode(
    values.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    }),
  );
}

test("public countTokens routes all HTTP providers to counting and never generation", async () => {
  for (const provider of [
    "claude",
    "kimi",
    "kimi-ai",
    "gemini",
    "gemini-interactions",
    "vertex",
    "antigravity",
    "codex",
    "xai",
    "meta",
    "devin",
    "openai-compatibility",
  ] as Provider[]) {
    const credentials = state(provider);
    if (provider === "meta") credentials.credentials.baseURL = "https://api.meta.ai/v1";
    if (provider === "openai-compatibility")
      credentials.credentials.baseURL = "https://fixture.example/v1";
    let calls = 0;
    const session = new ProviderSession({
      state: encodeState(credentials),
      fetch: async (input, init) => {
        calls++;
        const url = String(input);
        assert.match(url, /count_tokens|countTokens/, provider);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.stream, undefined);
        if (provider === "antigravity") {
          assert.equal(body.project, undefined);
          assert.equal(body.model, undefined);
          assert.equal(body.request.contents[0].parts[0].text, "hello");
        }
        return Response.json(
          url.includes("countTokens") ? { totalTokens: 12 } : { input_tokens: 12 },
        );
      },
    });
    try {
      const result = await session.countTokens(chat);
      assert.ok(result.ok, provider + ": " + JSON.stringify(result));
      const estimated = ["codex", "xai", "meta", "devin", "openai-compatibility"].includes(
        provider,
      );
      assert.equal(result.value.estimated, estimated, provider);
      assert.equal(calls, estimated ? 0 : 1, provider);
      assert.equal(session.getStats().requestsSent, 0);
      if (!estimated) assert.equal(result.value.inputTokens, 12);
      const responseCount = await session.countTokens({ model: "m", input: "hello" });
      assert.ok(responseCount.ok);
      assert.deepEqual(responseCount.value, result.value);
    } finally {
      await session.close();
    }
  }
});

test("native routes preserve provider fields and unsupported paths do not generate", async () => {
  const native = {
    model: "claude-opus-4-8",
    messages: [],
    max_tokens: 100,
    cache_control: { type: "ephemeral" },
  };
  const response = await executeAnthropic(request("/v1/messages", native), async (body) => {
    assert.deepEqual(body, native);
    return Response.json({ content: [] });
  });
  assert.deepEqual(await response.json(), { content: [] });
  const counted = await executeAnthropic(
    request("/v1/messages/count_tokens", native),
    async (body, _signal, action) => {
      assert.equal(action, "count");
      assert.deepEqual(body, native);
      return Response.json({ input_tokens: 1 });
    },
  );
  assert.equal((await counted.json()).input_tokens, 1);
  await executeGemini(
    request("/v1beta/models/gemini-test:countTokens", {
      contents: [],
      generateContentRequest: { tools: [] },
    }),
    async (body, _signal, action) => {
      assert.equal(action, "count");
      assert.equal(body.model, "gemini-test");
      assert.deepEqual(body.generateContentRequest, { tools: [] });
      return Response.json({ totalTokens: 3 });
    },
  );
  for (const execute of [executeAnthropic, executeGemini]) {
    const invalid = await execute(request("/v1/missing", chat), async () => {
      throw new Error("must not generate");
    });
    assert.equal(invalid.status, 404);
    assert.equal(
      (
        await execute(new Request("https://fixture/v1/chat/completions"), async () => {
          throw new Error("must not generate");
        })
      ).status,
      405,
    );
  }
});

test("adaptive Claude capabilities include 4.7, 4.8 and 5 while older models keep budgets", async () => {
  for (const [model, effort] of [
    ["claude-opus-4-6", "high"],
    ["claude-opus-4-7", "xhigh"],
    ["claude-opus-4-8", "xhigh"],
    ["claude-sonnet-5", "xhigh"],
  ]) {
    await executeAnthropic(
      request("/v1/chat/completions", { ...chat, model, reasoning_effort: "xhigh" }),
      async (body) => {
        assert.deepEqual(body.thinking, { type: "adaptive" });
        assert.deepEqual(body.output_config, { effort });
        return Response.json({ content: [{ type: "text", text: "yes" }], stop_reason: "end_turn" });
      },
    );
  }
  await executeAnthropic(
    request("/v1/chat/completions", { ...chat, model: "claude-opus-4-5", reasoning_effort: "low" }),
    async (body) => {
      assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 1024 });
      return Response.json({ content: [], stop_reason: "end_turn" });
    },
  );
});

test("Antigravity special nonstream models collect native SSE including tools, thoughts and usage", async () => {
  const adapter = getProvider("antigravity")!;
  for (const model of ["claude-opus-4-6", "gemini-3-pro", "gemini-3.1-flash-image"]) {
    const response = await adapter.execute(
      request("/v1/chat/completions", { ...chat, model }),
      state("antigravity"),
      context(async (input) => {
        assert.match(String(input), /streamGenerateContent\?alt=sse$/);
        return sse([
          {
            response: {
              candidates: [
                { content: { parts: [{ text: "考", thought: true, thoughtSignature: "sig" }] } },
              ],
            },
          },
          { response: { candidates: [{ content: { parts: [{ text: "hel" }] } }] } },
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [
                      { text: "lo" },
                      { functionCall: { name: "f", args: {} }, thoughtSignature: "tool-sig" },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
            },
          },
        ]);
      }),
    );
    const value = await response.json();
    assert.equal(value.choices[0].message.content, "hello");
    assert.equal(value.choices[0].message.reasoning_blocks[0].thoughtSignature, "sig");
    assert.equal(value.choices[0].message.tool_calls[0].thought_signature, "tool-sig");
    assert.equal(value.usage.total_tokens, 5);
  }
  await assert.rejects(
    collectGeminiStream(
      sse([{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }]),
      new AbortController().signal,
    ),
    /before completion/,
  );
});

test("signed reasoning and tool signatures roundtrip through Responses JSON without replaying summaries", () => {
  for (const blocks of [
    [
      { type: "thinking", thinking: "secret", signature: "signed" },
      { type: "redacted_thinking", data: "opaque" },
    ],
    [{ thought: true, text: "think", thoughtSignature: "signed" }],
  ]) {
    const output = chatCompletionToResponse(
      {
        id: "c",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "answer",
              reasoning_content: "think",
              reasoning_blocks: blocks,
              tool_calls: [
                {
                  id: "f",
                  function: { name: "tool", arguments: "{}" },
                  thought_signature: "tool-sig",
                },
              ],
            },
          },
        ],
      },
      {},
    );
    const replay = responsesToChat({ input: output.output });
    assert.deepEqual(replay.messages[0].reasoning_blocks, blocks);
    assert.equal(replay.messages[0].content[0].text, "answer");
    assert.equal(replay.messages[0].tool_calls[0].thought_signature, "tool-sig");
    const tampered = structuredClone(output.output);
    tampered[0].encrypted_content += "a";
    assert.throws(() => responsesToChat({ input: tampered }));
  }
  const item = { type: "reasoning", encrypted_content: "native-openai-ciphertext", summary: [] };
  const message = responseToChatCompletion({ output: [item] }).choices[0].message;
  assert.deepEqual(chatToResponses({ messages: [message] }).input, [item]);
});

test("streamed signed Anthropic reasoning survives terminal Responses output and replay", async () => {
  const result = await executeAnthropic(
    request("/v1/responses", { model: "claude-opus-4-8", input: "hello", stream: true }),
    async () =>
      sse([
        { type: "message_start", message: { id: "m", usage: { input_tokens: 2 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "think" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "signed" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]),
  );
  let output: any[] = [];
  for await (const event of parseSSE(result.body!)) {
    const value = JSON.parse(event.data);
    if (value.type === "response.completed") output = value.response.output;
  }
  assert.deepEqual(responsesToChat({ input: output }).messages[0].reasoning_blocks, [
    { type: "thinking", thinking: "think", signature: "signed" },
  ]);
});

test("Claude and Antigravity compact generate summaries, validate capsules, and replay context", async () => {
  for (const provider of ["claude", "antigravity"] as const) {
    const adapter = getProvider(provider)!;
    const response = await adapter.execute(
      request("/v1/responses/compact", { model: "gemini-test", input: "task" }),
      state(provider),
      context(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const prompt =
          provider === "claude"
            ? body.messages.at(-1).content[0].text
            : body.request.contents.at(-1).parts[0].text;
        assert.match(prompt, /summary/);
        return Response.json(
          provider === "claude"
            ? {
                id: "m",
                content: [{ type: "text", text: "summary" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 2, output_tokens: 1 },
              }
            : { candidates: [{ content: { parts: [{ text: "summary" }] }, finishReason: "STOP" }] },
        );
      }),
    );
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.object, "response.compaction");
    assert.equal(unseal(compactionPrefix, value.output[0].encrypted_content).summary, "summary");
    assert.match(responsesToChat({ input: value.output }).messages[0].content, /summary/);
    const bad = await adapter.execute(
      request("/v1/responses", {
        model: "m",
        input: [{ type: "compaction", encrypted_content: "bad" }],
      }),
      state(provider),
      context(async () => {
        throw new Error("must not send");
      }),
    );
    assert.equal(bad.status, 400);
  }
});

test("xAI speech maps SDK fields, uses official API with OAuth, and preserves audio and errors", async () => {
  const adapter = getProvider("xai")!,
    credentials = state("xai");
  delete credentials.credentials.apiKey;
  const response = await adapter.execute(
    request("/v1/audio/speech", {
      model: "tts-1",
      input: "hello",
      voice: "alloy",
      response_format: "pcm",
    }),
    credentials,
    context(async (url, init) => {
      assert.equal(String(url), "https://api.x.ai/v1/tts");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        text: "hello",
        voice_id: "ara",
        language: "auto",
        output_format: { codec: "pcm", sample_rate: 24000 },
      });
      return new Response(new Uint8Array([0, 255, 1]), { headers: { "x-request-id": "audio" } });
    }),
  );
  assert.equal(response.headers.get("content-type"), "audio/pcm");
  assert.equal(response.headers.get("x-request-id"), "audio");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 255, 1]));
  const invalid = await adapter.execute(
    request("/v1/audio/speech", { model: "m", input: "text", voice: "alloy" }),
    credentials,
    context(async () => {
      throw new Error("must not send");
    }),
  );
  assert.equal(invalid.status, 400);
  const denied = await adapter.execute(
    request("/v1/tts", { text: "hello" }),
    credentials,
    context(async () => Response.json({ error: "denied" }, { status: 403 })),
  );
  assert.equal(denied.status, 403);
  const compact = await adapter.execute(
    request("/v1/responses/compact", { model: "grok", input: "task" }),
    credentials,
    context(async (url) => {
      assert.equal(String(url), "https://api.x.ai/v1/responses/compact");
      return Response.json({ object: "response.compaction" });
    }),
  );
  assert.equal(compact.status, 200);
});

test("public Responses socket authenticates, exchanges events, and closes on session close", async () => {
  const server = createServer(),
    sockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const session = new ProviderSession({
    state: encodeState({
      ...state("codex"),
      credentials: { apiKey: "fixture", baseURL: `http://127.0.0.1:${address.port}/v1` },
    }),
  });
  sockets.on("connection", (socket, incoming) => {
    assert.equal(incoming.url, "/v1/responses");
    assert.equal(incoming.headers.authorization, "Bearer fixture");
    assert.match(String(incoming.headers["openai-beta"]), /responses_websockets/);
    socket.on("message", (data) => {
      assert.equal(JSON.parse(data.toString()).type, "response.create");
      socket.send(JSON.stringify({ type: "response.completed", response: { id: "r" } }));
    });
  });
  try {
    const result = await session.openResponsesSocket();
    assert.ok(result.ok);
    const message = once(result.value, "message");
    result.value.send(JSON.stringify({ type: "response.create", model: "m", input: "hello" }));
    assert.equal(JSON.parse((await message)[0].toString()).response.id, "r");
    const closed = once(result.value, "close");
    await session.close();
    await closed;
    assert.equal((await session.openResponsesSocket()).ok, false);
  } finally {
    await session.close();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("native Gemini and Interactions APIs are reachable through the managed SDK", async () => {
  for (const provider of ["gemini", "gemini-interactions"] as const) {
    const session = new ProviderSession({
      state: encodeState(state(provider)),
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/models")) return Response.json({ models: [] });
        const body = JSON.parse(String(init?.body));
        assert.equal(body.custom_native_field, "preserved");
        assert.match(url, provider === "gemini" ? /gemini-test:generateContent$/ : /interactions$/);
        return Response.json({ native: true });
      },
    });
    try {
      const created = await session.createSDK();
      assert.ok(created.ok);
      const path =
        provider === "gemini"
          ? "/../v1beta/models/gemini-test:generateContent"
          : "/../v1beta/interactions";
      const result = await created.value.post(path, {
        body: { model: "gemini-test", custom_native_field: "preserved", contents: [] },
      });
      assert.deepEqual(result, { native: true });
    } finally {
      await session.close();
    }
  }
});

test("token counts reject malformed input, preserve rate-limit failures, and validate provider counts", async () => {
  const session = new ProviderSession({
    state: encodeState(state("gemini")),
    fetch: async () => Response.json({ totalTokens: -1 }),
  });
  assert.equal((await session.countTokens(chat)).ok, false);
  await session.close();
  const limited = new ProviderSession({
    state: encodeState(state("claude")),
    fetch: async () => new Response("private details", { status: 429 }),
  });
  const result = await limited.countTokens(chat);
  assert.ok(!result.ok);
  assert.equal(result.error.code, "rate-limited");
  assert.equal(result.error.retryable, true);
  await limited.close();
  for (const execute of [executeGemini, executeAnthropic]) {
    assert.equal(
      (
        await execute(
          new Request("https://fixture/v1/chat/completions/count_tokens", {
            method: "POST",
            body: "{",
          }),
          async () => {
            throw new Error("must not send");
          },
        )
      ).status,
      400,
    );
  }
});

test("Gemini streamed signed reasoning and tool calls replay through terminal Responses", async () => {
  const response = await executeGemini(
    request("/v1/responses", { model: "gemini-test", input: "hello", stream: true }),
    async () =>
      sse([
        {
          candidates: [
            {
              index: 0,
              content: {
                parts: [{ thought: true, text: "think" }],
              },
            },
          ],
        },
        {
          candidates: [
            {
              index: 0,
              content: { parts: [{ thought: true, text: "", thoughtSignature: "reason-sig" }] },
            },
          ],
        },
        {
          candidates: [
            {
              index: 0,
              content: {
                parts: [
                  {
                    functionCall: { id: "call", name: "f", args: {} },
                    thoughtSignature: "tool-sig",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      ]),
  );
  let output: any[] = [];
  for await (const event of parseSSE(response.body!)) {
    const value = JSON.parse(event.data);
    if (value.type === "response.completed") output = value.response.output;
  }
  const replay = responsesToChat({ input: output });
  assert.equal(replay.messages[0].reasoning_blocks[0].thoughtSignature, "reason-sig");
  assert.equal(replay.messages[0].tool_calls[0].thought_signature, "tool-sig");
});

test("compaction triggers stream a completed capsule and reject incomplete summaries", async () => {
  const response = await executeAnthropic(
    request("/v1/responses", {
      model: "claude-opus-4-8",
      input: [{ role: "user", content: "task" }, { type: "compaction_trigger" }],
      stream: true,
    }),
    async (body) => {
      assert.equal(body.stream, false);
      return Response.json({
        content: [{ type: "text", text: "summary" }],
        stop_reason: "end_turn",
      });
    },
  );
  const types: string[] = [];
  for await (const event of parseSSE(response.body!)) types.push(JSON.parse(event.data).type);
  assert.equal(types.at(-1), "response.completed");
  const truncated = await executeAnthropic(
    request("/v1/responses/compact", { model: "claude-opus-4-8", input: "task" }),
    async () =>
      Response.json({ content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens" }),
  );
  assert.equal(truncated.status, 502);
});

test("Responses sockets fail safely on rejected upgrades and caller cancellation", async () => {
  const server = createServer((_req, response) => {
    response.writeHead(401);
    response.end("private error");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const session = new ProviderSession({
    state: encodeState({
      ...state("codex"),
      credentials: { apiKey: "fixture", baseURL: `http://127.0.0.1:${address.port}/v1` },
    }),
  });
  try {
    const denied = await session.openResponsesSocket();
    assert.ok(!denied.ok);
    assert.equal(denied.error.code, "auth-required");
    assert.ok(!denied.error.message.includes("private"));
    const cancelled = await session.openResponsesSocket({ signal: AbortSignal.abort() });
    assert.ok(!cancelled.ok);
    assert.equal(cancelled.error.code, "cancelled");
  } finally {
    await session.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("compact keeps tool history usable and prevents the summary from requesting tools", async () => {
  for (const definitions of [false, true]) {
    const response = await executeAnthropic(
      request("/v1/responses/compact", {
        model: "claude-opus-4-8",
        input: [
          { role: "user", content: "task" },
          { type: "function_call", call_id: "f", name: "tool", arguments: "{}" },
          { type: "function_call_output", call_id: "f", output: "result" },
        ],
        ...(definitions
          ? { tools: [{ type: "function", name: "tool", parameters: { type: "object" } }] }
          : {}),
      }),
      async (body) => {
        const messages = body.messages as Record<string, any>[];
        if (definitions) {
          assert.deepEqual(body.tool_choice, { type: "none" });
          assert.equal(messages[1]!.content[0].type, "tool_use");
          assert.equal(messages[2]!.content[0].type, "tool_result");
        } else {
          assert.match(messages[1]!.content[0].text, /Tool call tool/);
          assert.match(messages[2]!.content[0].text, /Tool result f/);
        }
        return Response.json({
          content: [{ type: "text", text: "summary" }],
          stop_reason: "end_turn",
        });
      },
    );
    assert.equal(response.status, 200);
  }
});
