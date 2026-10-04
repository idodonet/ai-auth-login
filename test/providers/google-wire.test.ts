import assert from "node:assert/strict";
import test from "node:test";
import { executeGemini, executeInteractions } from "../../src/protocols/gemini.js";
import { antigravity } from "../../src/providers/antigravity/index.js";

const request = (stream = false) =>
  new Request("https://internal/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gemini", messages: [{ role: "user", content: "Hi" }], stream }),
  });
const sse = (values: unknown[]) =>
  new Response(values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

test("Interactions translates documented steps, including function calls", async () => {
  const response = await executeInteractions(request(), async () =>
    Response.json({
      id: "i1",
      steps: [
        { type: "model_output", content: [{ type: "text", text: "Hello" }] },
        { type: "function_call", id: "call1", name: "lookup", arguments: { q: "x" } },
      ],
    }),
  );
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "Hello");
  assert.equal(body.choices[0].message.tool_calls[0].id, "call1");
  assert.equal(body.choices[0].finish_reason, "tool_calls");
});

for (const [name, execute] of [
  ["Gemini", executeGemini],
  ["Interactions", executeInteractions],
] as const) {
  test(`${name} rejects streams ending before a terminal event`, async () => {
    for (const values of [
      [],
      name === "Gemini"
        ? [{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }]
        : [{ event_type: "step.delta", index: 0, delta: { type: "text", text: "partial" } }],
    ]) {
      const response = await execute(request(true), async () => sse(values));
      await assert.rejects(response.text(), /ended before completion/);
    }
  });
}

test("Gemini streamed prompt block exposes content_filter", async () => {
  const response = await executeGemini(request(true), async () =>
    sse([{ promptFeedback: { blockReason: "SAFETY" } }]),
  );
  const body = await response.text();
  assert.match(body, /content_filter/);
  assert.match(body, /SAFETY/);
  assert.ok(!body.includes("[DONE]"));
});

test("Antigravity sends only native GenerateContent fields", async () => {
  const response = await antigravity.execute(
    request(),
    {
      provider: "antigravity",
      authenticatedAt: new Date().toISOString(),
      credentials: { accessToken: "fixture", project: "fixture-project" },
    },
    {
      signal: new AbortController().signal,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.request.stream, undefined);
        assert.equal(body.request.model, undefined);
        return Response.json({
          response: {
            candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          },
        });
      }) as typeof fetch,
    },
  );
  assert.equal(response.status, 200);
});

for (const [name, execute] of [
  ["Gemini", executeGemini],
  ["Interactions", executeInteractions],
] as const) {
  test(`${name} rejects invalid successful response envelopes`, async () => {
    for (const body of ['{"unexpected":"proxy error"}', "not json", "null"]) {
      const response = await execute(request(), async () => new Response(body));
      assert.equal(response.status, 502);
    }
  });
}

test("Gemini skips discovery only for structural preflight", async () => {
  const { gemini } = await import("../../src/providers/gemini/index.js");
  let calls = 0;
  const context = {
    signal: new AbortController().signal,
    fetch: (async () => {
      calls++;
      return Response.json({ models: [] });
    }) as typeof fetch,
  };
  const state = await gemini.connect({ kind: "api-key", apiKey: "fixture" }, context);
  assert.ok(state.ok);
  assert.ok((await gemini.checkAuth(state.value, context, { validate: false })).ok);
  assert.equal(calls, 0);
  assert.ok((await gemini.checkAuth(state.value, context)).ok);
  assert.equal(calls, 1);
  assert.equal(
    (
      await gemini.checkAuth({ ...state.value, credentials: { apiKey: " " } }, context, {
        validate: false,
      })
    ).ok,
    false,
  );
});

test("Antigravity force refresh replaces a token before its local expiry", async () => {
  let calls = 0;
  const state = {
    provider: "antigravity" as const,
    authenticatedAt: new Date().toISOString(),
    credentials: {
      project: "fixture",
      accessToken: "cached",
      refreshToken: "fixture",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  };
  const context = {
    signal: new AbortController().signal,
    fetch: (async () => {
      calls++;
      return Response.json({ access_token: "fresh", expires_in: 3600 });
    }) as typeof fetch,
  };
  await antigravity.checkAuth(state, context);
  assert.equal(calls, 0);
  const result = await antigravity.checkAuth(state, context, { forceRefresh: true });
  assert.ok(result.ok);
  assert.equal(result.value.credentials.accessToken, "fresh");
  assert.equal(calls, 1);
});

test("Antigravity invalid_grant requires a fresh login", async () => {
  const result = await antigravity.checkAuth(
    {
      provider: "antigravity",
      authenticatedAt: "2020-01-01",
      credentials: {
        project: "fixture",
        accessToken: "fixture",
        refreshToken: "fixture",
        expiresAt: "2020-01-01",
      },
    },
    {
      signal: new AbortController().signal,
      fetch: (async () =>
        Response.json(
          { error: "invalid_grant", error_description: "private details" },
          { status: 400 },
        )) as typeof fetch,
    },
  );
  assert.ok(!result.ok);
  assert.equal(result.error.code, "auth-required");
  assert.equal(result.error.retryable, false);
  assert.ok(!result.error.message.includes("private"));
});

test("Google translators reject malformed collection entries with 502", async () => {
  for (const candidates of [
    [null],
    [{ content: null }],
    [{ content: { parts: [null] } }],
    [{ content: { parts: { text: "invalid" } } }],
  ]) {
    const response = await executeGemini(request(), async () => Response.json({ candidates }));
    assert.equal(response.status, 502);
  }
  for (const steps of [
    [null],
    [{ type: "model_output", content: [null] }],
    [{ type: "model_output", content: { text: "invalid" } }],
  ]) {
    const response = await executeInteractions(request(), async () => Response.json({ steps }));
    assert.equal(response.status, 502);
  }
});
