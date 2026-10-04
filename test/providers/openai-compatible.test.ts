import test from "node:test";
import assert from "node:assert/strict";
import { createProvider } from "../../src/providers/openai-compatible/index.js";
import type { ProviderContext } from "../../src/providers/contract.js";
import { ProviderSession } from "../../src/session.js";

const context = (fetch: typeof globalThis.fetch): ProviderContext => ({
  fetch,
  signal: new AbortController().signal,
});
test("custom endpoint validation and opaque streaming forwarding", async () => {
  const provider = createProvider();
  const ctx = context(async (input, init) => {
    assert.equal(String(input), "https://upstream.test/api/v1/files?purpose=batch");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
    assert.equal(
      new Headers(init?.headers).get("content-type"),
      "multipart/form-data; boundary=abc",
    );
    assert.equal(await new Response(init?.body).text(), "raw multipart");
    return new Response("upstream body", {
      status: 202,
      headers: { "content-type": "text/event-stream" },
    });
  });
  for (const baseURL of [
    "https://user:pass@upstream.test/v1",
    "http://remote.test/v1",
    "https://upstream.test/v1?secret=x",
    "https://upstream.test/v1#hash",
    "file:///tmp/x",
  ]) {
    assert.equal(
      (await provider.connect({ kind: "api-key", apiKey: "secret", baseURL }, ctx)).ok,
      false,
    );
  }
  const connected = await provider.connect(
    { kind: "api-key", apiKey: "secret", baseURL: "https://upstream.test/api/v1/" },
    ctx,
  );
  assert.ok(connected.ok);
  const response = await provider.execute(
    new Request("https://sdk.invalid/v1/files?purpose=batch", {
      method: "POST",
      body: "raw multipart",
      headers: {
        authorization: "Bearer wrong",
        "content-type": "multipart/form-data; boundary=abc",
      },
    }),
    connected.value,
    ctx,
  );
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(await response.text(), "upstream body");
});

test("live models preserve metadata and auth failures are results", async () => {
  const provider = createProvider();
  const model = { id: "real-model", object: "model", created: 123, owned_by: "upstream" };
  let status = 200;
  const ctx = context(async (input) => {
    assert.equal(String(input), "http://127.0.0.1:8080/v1/models");
    return Response.json({ data: [model] }, { status });
  });
  const connected = await provider.connect(
    { kind: "api-key", apiKey: "key", baseURL: "http://127.0.0.1:8080/v1" },
    ctx,
  );
  assert.ok(connected.ok);
  assert.deepEqual(await provider.listModels(connected.value, ctx), { ok: true, value: [model] });
  status = 401;
  const auth = await provider.checkAuth(connected.value, ctx);
  assert.equal(auth.ok, false);
  if (!auth.ok) {
    assert.equal(auth.error.code, "auth-required");
  }
});

test("SDK inference does not repeat model validation after creation", async () => {
  let modelCalls = 0;
  let inferenceCalls = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    if (String(input).endsWith("/models")) {
      modelCalls++;
      return modelCalls === 1 ? Response.json({ data: [] }) : new Response(null, { status: 503 });
    }
    assert.equal(String(input), "https://upstream.test/v1/chat/completions");
    inferenceCalls++;
    return Response.json({
      id: "fixture",
      object: "chat.completion",
      created: 123,
      model: "fixture-model",
      choices: [
        { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
      ],
    });
  };
  const session = new ProviderSession({ fetch });
  try {
    const connected = await session.connect("openai-compatibility", {
      kind: "api-key",
      apiKey: "fixture-key",
      baseURL: "https://upstream.test/v1",
    });
    assert.ok(connected.ok);
    const sdk = await session.createSDK({ maxRetries: 0 });
    assert.ok(sdk.ok);
    assert.equal(modelCalls, 1);
    const completion = await sdk.value.chat.completions.create({
      model: "fixture-model",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(completion.choices[0]?.message.content, "hello");
    assert.equal(modelCalls, 1);
    assert.equal(inferenceCalls, 1);
    const validated = await session.checkAuth();
    assert.equal(validated.ok, false);
    assert.equal(modelCalls, 2);
  } finally {
    await session.close();
  }
});
