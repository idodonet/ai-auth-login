import assert from "node:assert/strict";
import test from "node:test";
import { kimi, kimiAI } from "../../src/providers/kimi/index.js";
import type { CredentialState, ProviderContext } from "../../src/providers/contract.js";
import { ProviderSession } from "../../src/session.js";
import { encodeState } from "../../src/state.js";
const json = (value: unknown, status = 200) => Response.json(value, { status });
const context = (fetch: ProviderContext["fetch"]): ProviderContext => ({
  fetch,
  signal: new AbortController().signal,
});

test("Kimi providers refresh a rejected unexpired token and retry SDK requests", async () => {
  for (const provider of ["kimi", "kimi-ai"] as const) {
    const calls: string[] = [];
    const session = new ProviderSession({
      state: encodeState({
        provider,
        authenticatedAt: "2026-01-01T00:00:00Z",
        credentials: {
          accessToken: "old",
          refreshToken: "refresh",
          deviceID: "device",
          expiresAt: Date.now() + 3600_000,
        },
      }),
      fetch: async (url, init) => {
        calls.push(String(url));
        if (String(url).endsWith("/oauth/token")) {
          return json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
        }
        return new Headers(init?.headers).get("authorization") === "Bearer old"
          ? json({ error: { message: "Token invalidated" } }, 401)
          : json({
              id: "chat",
              choices: [
                {
                  message: { role: "assistant", content: "hello" },
                  index: 0,
                  finish_reason: "stop",
                },
              ],
            });
      },
    });
    try {
      const sdk = await session.createSDK({ maxRetries: 0 });
      assert.ok(sdk.ok);
      const result = await sdk.value.chat.completions.create({
        model: "kimi-k3",
        messages: [{ role: "user", content: "hello" }],
      });
      assert.equal(result.choices[0]?.message.content, "hello");
      assert.equal(calls.length, 3);
      assert.equal(JSON.parse(session.exportState()!).credentials.refreshToken, "rotated");
    } finally {
      await session.close();
    }
  }
});

test("Kimi AI refresh rotates tokens and preserves login timestamp", async () => {
  const state: CredentialState = {
    provider: "kimi-ai",
    authenticatedAt: "2026-01-01T00:00:00Z",
    credentials: { accessToken: "old", refreshToken: "refresh", expiresAt: 0, deviceID: "device" },
  };
  const result = await kimiAI.checkAuth(
    state,
    context(async (url, init) => {
      assert.equal(url, "https://auth.kimi.ai/api/oauth/token");
      assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "refresh");
      assert.equal(new Headers(init?.headers).get("X-Msh-Device-Id"), "device");
      return json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
    }),
  );
  assert.ok(result.ok);
  assert.equal(result.value.credentials.refreshToken, "rotated");
  assert.equal(result.value.authenticatedAt, state.authenticatedAt);
  assert.equal(state.credentials.accessToken, "old");
});

test("Kimi requests use coding endpoint, normalize catalog alias, preserve upstream errors", async () => {
  const connection = await kimi.connect({ kind: "api-key", apiKey: "key" }, context(fetch));
  assert.ok(connection.ok);
  const res = await kimi.execute(
    new Request("https://internal/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "kimi-k2.8", messages: [] }),
    }),
    connection.value,
    context(async (url, init) => {
      assert.equal(url, "https://api.kimi.com/coding/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer key");
      assert.equal(JSON.parse(String(init?.body)).model, "kimi-for-coding");
      return json({ error: { message: "limited" } }, 429);
    }),
  );
  assert.equal(res.status, 429);
});

test("device login polls pending then succeeds once for concurrent waits", async () => {
  let polls = 0;
  const begun = await kimi.beginAuth(
    context(async (url) => {
      if (String(url).endsWith("device_authorization")) {
        return json({
          device_code: "code",
          user_code: "USER",
          verification_uri: "https://auth.kimi.com/device",
          expires_in: 60,
          interval: 0.001,
        });
      }
      polls++;
      return polls === 1
        ? json({ error: "authorization_pending" })
        : json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    }),
  );
  assert.ok(begun.ok);
  assert.equal(begun.value.kind, "device");
  if (begun.value.kind !== "device") {
    return;
  }
  const [a, b] = await Promise.all([begun.value.wait(), begun.value.wait()]);
  assert.ok(a.ok);
  assert.deepEqual(a, b);
  assert.equal(polls, 2);
});

test("device cancellation never exchanges credentials", async () => {
  let polls = 0;
  const begun = await kimi.beginAuth(
    context(async (url) => {
      if (String(url).endsWith("device_authorization")) {
        return json({
          device_code: "code",
          verification_uri: "https://auth.kimi.com/device",
          expires_in: 60,
        });
      }
      polls++;
      return json({ access_token: "access" });
    }),
  );
  assert.ok(begun.ok);
  assert.equal(begun.value.kind, "device");
  if (begun.value.kind !== "device") {
    return;
  }
  begun.value.cancel();
  const result = await begun.value.wait();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cancelled");
  }
  assert.equal(polls, 0);
});

test("Kimi Responses stay native and normalize unsupported temperature", async () => {
  const connection = await kimiAI.connect({ kind: "api-key", apiKey: "key" }, context(fetch));
  assert.ok(connection.ok);
  const payload = {
    model: "kimi-k3",
    input: "hello",
    temperature: 0.4,
    tools: [{ type: "web_search" }],
  };
  const response = await kimiAI.execute(
    new Request("https://internal/v1/responses", { method: "POST", body: JSON.stringify(payload) }),
    connection.value,
    context(async (url, init) => {
      assert.equal(url, "https://api.kimi.ai/coding/v1/responses");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "k3");
      assert.equal(body.temperature, undefined);
      assert.deepEqual(body.tools, payload.tools);
      return json({ object: "response", output: [] });
    }),
  );
  assert.equal(response.status, 200);
});

test("Kimi inlines local tool schema references and rejects recursion before sending", async () => {
  const state: CredentialState = {
    provider: "kimi",
    authenticatedAt: null,
    credentials: { apiKey: "key" },
  };
  let calls = 0;
  const ctx = context(async (_, init) => {
    calls++;
    const schema = JSON.parse(String(init?.body)).tools[0].function.parameters;
    assert.deepEqual(schema, { type: "object", properties: { name: { type: "string" } } });
    return json({ choices: [] });
  });
  const req = (parameters: unknown) =>
    new Request("https://internal/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "kimi-k3",
        messages: [],
        tools: [{ type: "function", function: { name: "hello", parameters } }],
      }),
    });
  assert.equal(
    (
      await kimi.execute(
        req({
          $defs: { Name: { type: "string" } },
          properties: { name: { $ref: "#/$defs/Name" } },
        }),
        state,
        ctx,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await kimi.execute(
        req({
          $defs: { Node: { $ref: "#/$defs/Node" } },
          properties: { name: { $ref: "#/$defs/Node" } },
        }),
        state,
        ctx,
      )
    ).status,
    400,
  );
  assert.equal(calls, 1);
});
