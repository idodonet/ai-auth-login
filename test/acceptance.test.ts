import test from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { ProviderSession } from "../src/session.js";
import type { Provider, Result } from "../src/types.js";

function unwrap<T>(result: Result<T>): T {
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error));
  return result.value;
}
const model = { id: "fixture-model", object: "model", created: 12, owned_by: "fixture" };
const completion = {
  id: "chat_fixture",
  object: "chat.completion",
  created: 12,
  model: model.id,
  choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
};
const response = {
  id: "resp_fixture",
  object: "response",
  created_at: 12,
  status: "completed",
  model: model.id,
  output: [
    {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello", annotations: [] }],
    },
  ],
  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
};
const sse = (events: unknown[]) =>
  new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

async function mockNetwork<T>(fetch: typeof globalThis.fetch, run: () => Promise<T>) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test("public state lifecycle and genuine SDK forwarding, models and tools", async () => {
  let saved: string | null = null;
  const bodies: Record<string, any>[] = [];
  await mockNetwork(
    async (input, init) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).origin, "https://upstream.test");
      assert.equal(request.headers.get("authorization"), "Bearer fixture-key");
      if (request.method === "POST") {
        assert.equal(request.headers.get("openai-project"), "configured-project");
      }
      if (request.method === "GET") {
        return Response.json({ data: [model] });
      }
      bodies.push(await request.json());
      return Response.json(request.url.endsWith("/responses") ? response : completion);
    },
    async () => {
      const session = new ProviderSession();
      session.onStateChange((state) => {
        saved = state;
      });
      unwrap(
        await session.connect("openai-compatibility", {
          kind: "api-key",
          apiKey: "fixture-key",
          baseURL: "https://upstream.test/v1",
        }),
      );
      assert.equal(session.provider, "openai-compatibility");
      assert.ok(saved);
      const restored = new ProviderSession({ state: saved });
      assert.deepEqual(unwrap(await restored.checkAuth()), { valid: true });
      const sdk = unwrap(await session.createSDK({ maxRetries: 0, project: "configured-project" }));
      assert.ok(sdk instanceof OpenAI);
      assert.deepEqual((await sdk.models.list()).data, unwrap(await session.listModels()));
      assert.deepEqual(await sdk.models.retrieve(model.id), model);
      const tools = [
        {
          type: "function" as const,
          function: { name: "weather", parameters: { type: "object" } },
        },
      ];
      assert.equal(
        (
          await sdk.chat.completions.create({
            model: model.id,
            messages: [{ role: "user", content: "Hello" }],
            tools,
          })
        ).choices[0]?.message.content,
        "Hello",
      );
      assert.equal(
        (
          await sdk.responses.create({
            model: model.id,
            input: "Hello",
            tools: [
              { type: "function", name: "weather", parameters: { type: "object" }, strict: false },
            ],
          })
        ).output_text,
        "Hello",
      );
      assert.deepEqual(bodies[0]?.tools, tools);
      assert.equal(bodies[1]?.tools[0]?.name, "weather");
      assert.equal(session.getStats().requestsSent, 2);
      assert.equal(session.getStats().requestsFailed, 0);
      await session.close();
      assert.equal(session.exportState(), saved);
      await assert.rejects(sdk.models.list(), OpenAI.AuthenticationError);
      await session.close();
      await restored.logout();
      assert.equal(restored.exportState(), null);
      await restored.close();
    },
  );
});

test("SDK counts actual retries and preserves provider HTTP errors", async () => {
  let attempts = 0;
  await mockNetwork(
    async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        return Response.json({ data: [model] });
      }
      attempts++;
      return Response.json(
        { error: { message: "Quota exceeded", type: "rate_limit_error" } },
        { status: 429, headers: { "retry-after-ms": "1" } },
      );
    },
    async () => {
      const session = new ProviderSession();
      unwrap(
        await session.connect("openai-compatibility", {
          kind: "api-key",
          apiKey: "fixture-key",
          baseURL: "https://upstream.test/v1",
        }),
      );
      const sdk = unwrap(await session.createSDK({ maxRetries: 1 }));
      await assert.rejects(
        sdk.chat.completions.create({
          model: model.id,
          messages: [{ role: "user", content: "Hello" }],
        }),
        (error: unknown) =>
          error instanceof OpenAI.RateLimitError &&
          error.status === 429 &&
          error.message.includes("Quota exceeded"),
      );
      assert.equal(attempts, 2);
      assert.equal(session.getStats().requestsSent, 2);
      assert.equal(session.getStats().requestsFailed, 2);
      await session.close();
    },
  );
});

test("SDK reads chat and Responses SSE and close cancels an active body", async () => {
  let cancelled = false;
  let pending = false;
  await mockNetwork(
    async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        return Response.json({ data: [model] });
      }
      if (pending) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"id":"chat_fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return request.url.endsWith("/responses")
        ? sse([
            {
              type: "response.output_text.delta",
              delta: "Hello",
              sequence_number: 1,
              output_index: 0,
              content_index: 0,
              item_id: "msg_fixture",
            },
            { type: "response.completed", response },
          ])
        : sse([
            {
              id: "chat_fixture",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
            },
          ]);
    },
    async () => {
      const session = new ProviderSession();
      unwrap(
        await session.connect("openai-compatibility", {
          kind: "api-key",
          apiKey: "fixture-key",
          baseURL: "https://upstream.test/v1",
        }),
      );
      const sdk = unwrap(await session.createSDK({ maxRetries: 0 }));
      let chatText = "";
      for await (const part of await sdk.chat.completions.create({
        model: model.id,
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      })) {
        chatText += part.choices[0]?.delta.content ?? "";
      }
      assert.equal(chatText, "Hello");
      let responseText = "";
      for await (const part of await sdk.responses.create({
        model: model.id,
        input: "Hello",
        stream: true,
      })) {
        if (part.type === "response.output_text.delta") {
          responseText += part.delta;
        }
      }
      assert.equal(responseText, "Hello");
      pending = true;
      const stream = await sdk.chat.completions.create({
        model: model.id,
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      });
      const iterator = stream[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).done, false);
      await session.close();
      assert.equal((await iterator.next()).done, true);
      assert.equal(cancelled, true);
    },
  );
});

const apiProviders: Provider[] = [
  "codex",
  "claude",
  "kimi",
  "kimi-ai",
  "xai",
  "meta",
  "gemini",
  "gemini-interactions",
  "vertex",
  "openai-compatibility",
];
for (const provider of apiProviders) {
  test(`${provider}: restored login and identical model discovery through public SDK`, async () => {
    const calls: Request[] = [];
    await mockNetwork(
      async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        assert.ok(!request.headers.get("authorization")?.includes("internally-managed"));
        if (request.url.includes("generativelanguage.googleapis.com")) {
          assert.equal(request.headers.get("x-goog-api-key"), "fixture-key");
          return Response.json({
            models: [
              { name: "models/fixture-model", supportedGenerationMethods: ["generateContent"] },
            ],
          });
        }
        if (provider === "codex") {
          return Response.json({ models: [{ slug: model.id }] });
        }
        return Response.json({ data: [model] });
      },
      async () => {
        const session = new ProviderSession();
        unwrap(
          await session.connect(provider, {
            kind: "api-key",
            apiKey: "fixture-key",
            ...(provider === "openai-compatibility" ? { baseURL: "https://upstream.test/v1" } : {}),
          }),
        );
        const state = session.exportState();
        assert.ok(state);
        const restored = new ProviderSession({ state });
        assert.deepEqual(unwrap(await restored.checkAuth()), { valid: true });
        const sdk = unwrap(await restored.createSDK({ maxRetries: 0 }));
        const models = unwrap(await restored.listModels());
        assert.ok(models.length > 0);
        assert.deepEqual((await sdk.models.list()).data, models);
        assert.equal(restored.provider, provider);
        assert.equal(restored.getStats().requestsSent, 0);
        await session.close();
        await restored.close();
      },
    );
  });
}

test("Antigravity restored credentials discover models through both public paths", async () => {
  await mockNetwork(
    async (input, init) => {
      const request = new Request(input, init);
      assert.equal(
        request.url,
        "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      );
      assert.equal(request.headers.get("authorization"), "Bearer fixture-token");
      return Response.json({ models: { "fixture-model": {} } });
    },
    async () => {
      // Only tests understand this fixture; consumers persist exportState() untouched.
      const session = new ProviderSession({
        state: JSON.stringify({
          version: 1,
          provider: "antigravity",
          authenticatedAt: "2026-01-01T00:00:00Z",
          credentials: {
            accessToken: "fixture-token",
            refreshToken: "fixture-refresh",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            project: "fixture-project",
          },
        }),
      });
      const sdk = unwrap(await session.createSDK({ maxRetries: 0 }));
      assert.deepEqual((await sdk.models.list()).data, unwrap(await session.listModels()));
      await session.close();
    },
  );
});

test("Devin status protobuf validation precedes public model discovery", async () => {
  await mockNetwork(
    async (input, init) => {
      const request = new Request(input, init);
      assert.ok(request.url.endsWith("/GetUserStatus"));
      assert.equal(request.headers.get("content-type"), "application/proto");
      assert.equal(
        request.headers.get("authorization"),
        "Basic devin-session-token$fixture-devin-session-token$fixture",
      );
      // Root field 1 contains an empty but structurally valid user status.
      return new Response(Uint8Array.of(10, 0));
    },
    async () => {
      const session = new ProviderSession();
      unwrap(await session.connect("devin", { kind: "api-key", apiKey: "fixture" }));
      const sdk = unwrap(await session.createSDK({ maxRetries: 0 }));
      assert.deepEqual((await sdk.models.list()).data, unwrap(await session.listModels()));
      await session.close();
    },
  );
});

test("callback completion returns displayable failures and does not destroy previous state", async () => {
  await mockNetwork(
    async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        assert.ok(request.url.includes("/codex/models"));
        return Response.json({ models: [{ slug: model.id }] });
      }
      assert.equal(request.url, "https://auth.openai.com/oauth/token");
      assert.equal(
        new URLSearchParams(await request.text()).get("grant_type"),
        "authorization_code",
      );
      return Response.json({
        access_token: "fixture-token",
        refresh_token: "fixture-refresh",
        expires_in: 3600,
      });
    },
    async () => {
      const session = new ProviderSession();
      unwrap(await session.connect("meta", { kind: "api-key", apiKey: "fixture-key" }));
      const previous = session.exportState();
      let changes = 0;
      session.onStateChange(() => {
        changes++;
      });
      const login = unwrap(await session.beginAuth("codex"));
      assert.equal(login.kind, "callback");
      if (login.kind !== "callback") {
        throw new Error("Expected callback");
      }
      const invalid = await login.complete(
        "http://localhost:1455/auth/callback?state=wrong&code=fixture-code",
      );
      assert.equal(invalid.ok, false);
      if (!invalid.ok) {
        assert.equal(invalid.error.code, "invalid-callback");
      }
      assert.equal(session.exportState(), previous);
      assert.equal(changes, 0);
      const authorization = new URL(login.url);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.set("code", "fixture-code");
      unwrap(await login.complete(callback.href));
      assert.equal(session.provider, "codex");
      assert.equal(changes, 1);
      const restored = new ProviderSession({ state: session.exportState()! });
      assert.deepEqual(unwrap(await restored.checkAuth()), { valid: true });
      await session.close();
      await session.logout();
      assert.equal(changes, 1);
      await restored.close();
    },
  );
});

test("AI Studio private relay works with real SDK and closes its listener", async () => {
  const { WebSocket } = await import("ws");
  const session = new ProviderSession();
  unwrap(await session.connect("aistudio", { kind: "relay" }));
  const connection = session.getConnection();
  assert.ok(connection);
  const browser = new WebSocket(connection.url, { origin: "https://aistudio.google.com" });
  try {
    await new Promise<void>((resolve, reject) => {
      browser.once("error", reject);
      browser.once("open", () =>
        browser.send(JSON.stringify({ type: "auth", payload: { token: connection.token } })),
      );
      browser.once("message", (raw) => {
        assert.equal(JSON.parse(raw.toString()).type, "auth_ok");
        resolve();
      });
    });
    browser.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "http_request") {
        return;
      }
      const url = new URL(message.payload.url);
      assert.equal(url.origin, "https://generativelanguage.googleapis.com");
      assert.equal(message.payload.headers.Authorization, undefined);
      const payload = url.pathname.endsWith("/models")
        ? { models: [{ name: "models/fixture-model" }] }
        : {
            candidates: [
              { content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" },
            ],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
          };
      browser.send(
        JSON.stringify({
          id: message.id,
          type: "http_response",
          payload: {
            status: 200,
            headers: { "content-type": ["application/json"] },
            body: JSON.stringify(payload),
          },
        }),
      );
    });
    const sdk = unwrap(await session.createSDK({ maxRetries: 0 }));
    assert.deepEqual((await sdk.models.list()).data, unwrap(await session.listModels()));
    const reply = await sdk.chat.completions.create({
      model: model.id,
      messages: [{ role: "user", content: "Hello" }],
    });
    assert.equal(reply.choices[0]?.message.content, "Hello");
    await session.close();
    assert.equal(session.getConnection(), null);
    await assert.rejects(sdk.models.list(), OpenAI.AuthenticationError);
  } finally {
    browser.terminate();
    await session.close();
  }
});

for (const provider of [
  "claude",
  "gemini",
  "gemini-interactions",
  "vertex",
  "xai",
  "meta",
  "kimi",
  "kimi-ai",
] as const) {
  test(`${provider}: real SDK Chat and Responses translate tools to native protocol`, async () => {
    let requests = 0;
    await mockNetwork(
      async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          return Response.json(
            request.url.includes("generativelanguage")
              ? {
                  models: [
                    {
                      name: "models/fixture-model",
                      supportedGenerationMethods: ["generateContent"],
                    },
                  ],
                }
              : { data: [model] },
          );
        }
        requests++;
        const body = (await request.json()) as Record<string, any>;
        if (provider === "claude") {
          assert.equal(new URL(request.url).hostname, "api.anthropic.com");
          assert.equal(request.headers.get("x-api-key"), "fixture-key");
          assert.equal(body.tools[0].name, "weather");
          assert.equal(body.messages[0].content[0].text, "Hello");
          return Response.json({
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: model.id,
            content: [
              { type: "tool_use", id: "call_fixture", name: "weather", input: { city: "Warsaw" } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 2, output_tokens: 1 },
          });
        }
        if (provider === "gemini-interactions") {
          assert.ok(request.url.endsWith("/interactions"));
          assert.equal(body.tools[0].name, "weather");
          return Response.json({
            id: "interaction_fixture",
            model: model.id,
            outputs: [
              {
                type: "function_call",
                call_id: "call_fixture",
                name: "weather",
                arguments: { city: "Warsaw" },
              },
            ],
            usage: { total_input_tokens: 2, total_output_tokens: 1 },
          });
        }
        if (provider === "gemini" || provider === "vertex") {
          assert.equal(request.headers.get("x-goog-api-key"), "fixture-key");
          assert.ok(request.url.endsWith("/models/fixture-model:generateContent"));
          assert.equal(body.tools[0].functionDeclarations[0].name, "weather");
          assert.equal(body.contents[0].parts[0].text, "Hello");
          return Response.json({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ functionCall: { name: "weather", args: { city: "Warsaw" } } }],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
          });
        }
        assert.equal(request.headers.get("authorization"), "Bearer fixture-key");
        if (provider === "xai" || provider === "meta") {
          assert.ok(request.url.endsWith("/responses"));
          assert.equal(body.tools[0].name, "weather");
          return Response.json({
            ...response,
            output: [
              {
                type: "function_call",
                id: "fc_fixture",
                call_id: "call_fixture",
                name: "weather",
                arguments: '{"city":"Warsaw"}',
                status: "completed",
              },
            ],
          });
        }
        if (request.url.endsWith("/v1/responses")) {
          assert.equal(body.tools[0].name, "weather");
          return Response.json({
            ...response,
            output: [
              {
                type: "function_call",
                id: "fc_fixture",
                call_id: "call_fixture",
                name: "weather",
                arguments: '{\"city\":\"Warsaw\"}',
                status: "completed",
              },
            ],
          });
        }
        assert.ok(request.url.endsWith("/v1/chat/completions"));
        assert.equal(body.tools[0].function.name, "weather");
        return Response.json({
          ...completion,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_fixture",
                    type: "function",
                    function: { name: "weather", arguments: '{"city":"Warsaw"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      },
      async () => {
        const session = new ProviderSession();
        unwrap(await session.connect(provider, { kind: "api-key", apiKey: "fixture-key" }));
        const sdk = unwrap(await session.createSDK({ maxRetries: 0 }));
        const parameters = { type: "object", properties: { city: { type: "string" } } };
        const chat = await sdk.chat.completions.create({
          model: model.id,
          messages: [{ role: "user", content: "Hello" }],
          tools: [{ type: "function", function: { name: "weather", parameters } }],
        });
        assert.equal(chat.choices[0]?.message.tool_calls?.[0]?.type, "function");
        const reply = await sdk.responses.create({
          model: model.id,
          input: "Hello",
          tools: [{ type: "function", name: "weather", parameters, strict: false }],
        });
        assert.equal(reply.output[0]?.type, "function_call");
        assert.equal(requests, 2);
        assert.equal(session.getStats().requestsSent, 2);
        await session.close();
      },
    );
  });
}
