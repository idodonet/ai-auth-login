import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { meta } from "../../src/providers/meta/index.js";
import type { ProviderContext, CredentialState } from "../../src/providers/contract.js";
const context = (fetch: ProviderContext["fetch"]): ProviderContext => ({
  fetch,
  signal: new AbortController().signal,
});
const credentials: CredentialState = {
  provider: "meta",
  authenticatedAt: "2026-01-01T00:00:00Z",
  credentials: { apiKey: "old", dcaToken: "device-secret" },
};
test("Meta mints and refreshes API credentials while preserving login time", async () => {
  const ctx = context(async (url, init) => {
    assert.equal(url, "https://api.meta.ai/muse-code/key");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer device-secret");
    assert.deepEqual(JSON.parse(String(init?.body)), { dca_token: "device-secret" });
    return Response.json({
      api_key: "new-key",
      base_url: "https://api.meta.ai/v1",
      user_email: "a@example.com",
      subs_tier_name: "Pro",
    });
  });
  const result = await meta.checkAuth(credentials, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.credentials.apiKey, "new-key");
  assert.equal(result.value.authenticatedAt, credentials.authenticatedAt);
  const account = await meta.getAccount(result.value, ctx);
  assert.equal(account.ok && account.value?.email, "a@example.com");
});
test("Meta rejects untrusted minted URLs and stored endpoint credentials", async () => {
  const result = await meta.checkAuth(
    credentials,
    context(async () => Response.json({ api_key: "key", base_url: "https://attacker.example/v1" })),
  );
  assert.equal(result.ok, false);
  const connected = await meta.connect(
    { kind: "api-key", apiKey: "key", baseURL: "https://api.meta.ai.attacker.example/v1" },
    context(globalThis.fetch),
  );
  assert.equal(connected.ok, false);
});
test("Meta device token is exchanged for a minted API key", async () => {
  const calls: string[] = [];
  const ctx = context(async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("authorization")) {
      return Response.json({
        device_code: "device",
        user_code: "ABCD",
        verification_uri: "https://auth.meta.com/device",
        expires_in: 600,
        interval: 0.001,
      });
    }
    if (String(url).includes("/token")) {
      assert.equal(new URLSearchParams(String(init?.body)).get("device_code"), "device");
      return Response.json({ access_token: "DCA" });
    }
    return Response.json({ api_key: "minted" });
  });
  const started = await meta.beginAuth(ctx);
  assert.equal(started.ok, true);
  if (!started.ok || started.value.kind !== "device") {
    return;
  }
  const done = await started.value.wait();
  assert.equal(done.ok && done.value.credentials.apiKey, "minted");
  assert.equal(calls.length, 3);
});
test("Meta forwards native Responses JSON and preserves real response shape", async () => {
  const upstream = {
    id: "resp_test",
    object: "response",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ],
  };
  const ctx = context(async (url, init) => {
    assert.equal(url, "https://api.meta.ai/v1/responses");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer old");
    assert.equal(JSON.parse(String(init?.body)).model, "muse-spark-1.3");
    return Response.json(upstream);
  });
  const response = await meta.execute(
    new Request("https://internal/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "muse-spark-1.3", input: "hello" }),
    }),
    credentials,
    ctx,
  );
  assert.deepEqual(await response.json(), upstream);
  const models = await meta.listModels(credentials, ctx);
  assert.equal(models.ok && models.value[0]?.id, "muse-spark-1.3");
});

test("Meta real SDK returns Responses and models without a local port", async () => {
  const ctx = context(async () =>
    Response.json({
      id: "resp_sdk",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "muse-spark-1.3",
      output: [
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hello", annotations: [] }],
        },
      ],
    }),
  );
  const sdk = new OpenAI({
    apiKey: "internal",
    baseURL: "https://internal/v1",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/v1/models") {
        const result = await meta.listModels(credentials, ctx);
        assert.equal(result.ok, true);
        return Response.json({ object: "list", data: result.ok ? result.value : [] });
      }
      return meta.execute(request, credentials, ctx);
    },
  });
  assert.equal(
    (await sdk.responses.create({ model: "muse-spark-1.3", input: "hello" })).output_text,
    "hello",
  );
  assert.equal((await sdk.models.list()).data[0]?.id, "muse-spark-1.3");
});

test("Meta request preparation skips mint; forced refresh remints once", async () => {
  let mints = 0;
  const ctx = context(async () => {
    mints++;
    return Response.json({ api_key: "fresh" });
  });
  const prepared = await meta.checkAuth(credentials, ctx, { validate: false });
  assert.equal(prepared.ok && prepared.value.credentials.apiKey, "old");
  assert.equal(mints, 0);
  const refreshed = await meta.checkAuth(credentials, ctx, { validate: false, forceRefresh: true });
  assert.equal(refreshed.ok && refreshed.value.credentials.apiKey, "fresh");
  assert.equal(mints, 1);
});
