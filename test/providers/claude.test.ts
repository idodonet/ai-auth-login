import test from "node:test";
import assert from "node:assert/strict";
import { claude } from "../../src/providers/claude/index.js";
import type { ProviderContext, CredentialState } from "../../src/providers/contract.js";
import { ProviderSession } from "../../src/session.js";
import { encodeState } from "../../src/state.js";
const context = (fetch: typeof globalThis.fetch): ProviderContext => ({
  fetch,
  signal: new AbortController().signal,
});
const oauth: CredentialState = {
  provider: "claude",
  authenticatedAt: "2026-01-01T00:00:00Z",
  credentials: { accessToken: "old", refreshToken: "refresh", expiresAt: "2020-01-01T00:00:00Z" },
};

test("Claude revoked refresh reports public reauthentication status", async () => {
  const session = new ProviderSession({
    state: encodeState(oauth),
    fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
  });
  try {
    assert.deepEqual(await session.checkAuth(), {
      ok: true,
      value: { valid: false, reason: "reauth-required" },
    });
    const invalidRequest = await claude.checkAuth(
      oauth,
      context(async () => Response.json({ error: "invalid_request" }, { status: 400 })),
    );
    assert.equal(invalidRequest.ok, false);
    if (!invalidRequest.ok) assert.equal(invalidRequest.error.code, "provider-error");
  } finally {
    await session.close();
  }
});

test("Claude refresh retains login timestamp and uses JSON control-plane request", async () => {
  const ctx = context(async (input, init) => {
    assert.equal(String(input), "https://platform.claude.com/v1/oauth/token");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.refresh_token, "refresh");
    return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
  });
  const result = await claude.checkAuth(oauth, ctx);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.authenticatedAt, oauth.authenticatedAt);
    assert.equal(result.value.credentials.accessToken, "new");
  }
});

test("Claude callback rejects state mismatch and accepts manual code#state", async () => {
  const ctx = context(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.code, "valid-code");
    assert.equal(body.grant_type, "authorization_code");
    return Response.json({ access_token: "token", refresh_token: "refresh", expires_in: 3600 });
  });
  const started = await claude.beginAuth(ctx);
  assert.equal(started.ok, true);
  if (!started.ok || started.value.kind !== "callback") {
    return;
  }
  const login = started.value;
  const bad = await login.complete("bad#wrong");
  assert.equal(bad.ok, false);
  const state = new URL(login.url).searchParams.get("state");
  const result = await login.complete(`valid-code#${state}`);
  assert.equal(result.ok, true);
  login.cancel();
});

test("Claude profile reports upstream identity and quota reads OAuth usage", async () => {
  const ctx = context(async (input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer old");
    if (String(input).endsWith("/usage"))
      return Response.json({ five_hour: { utilization: 20, resets_at: "2026-10-10T17:00:00Z" } });
    assert.equal(String(input), "https://api.anthropic.com/api/oauth/profile");
    return Response.json({ account: { uuid: "account", email: "a@example.com" } });
  });
  const result = await claude.getAccount(oauth, ctx);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value?.email, "a@example.com");
    assert.equal(result.value?.plan, null);
  }
  const quota = await claude.getQuota(oauth, ctx);
  assert.equal(quota.ok && quota.value.supported, true);
  if (quota.ok) assert.equal(quota.value.windows[0].remainingPercent, 80);
});

test("Claude inference replaces SDK credentials with provider-specific headers", async () => {
  for (const credentials of [
    { apiKey: "secret-api" },
    { accessToken: "secret-oauth" },
  ] as CredentialState["credentials"][]) {
    const ctx = context(async (input, init) => {
      assert.equal(String(input), "https://api.anthropic.com/v1/messages");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("anthropic-version"), "2023-06-01");
      if ("apiKey" in credentials) {
        assert.equal(headers.get("x-api-key"), "secret-api");
        assert.equal(headers.get("authorization"), null);
      } else {
        assert.equal(headers.get("authorization"), "Bearer secret-oauth");
        assert.equal(headers.get("x-api-key"), null);
      }
      return Response.json({
        id: "message",
        type: "message",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const request = new Request("https://internal/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer SDK-TOKEN", "x-api-key": "SDK-KEY" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const response = await claude.execute(request, { ...oauth, credentials }, ctx);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, "hello");
  }
});

test("Claude API key validity is checked upstream", async () => {
  const state: CredentialState = { ...oauth, credentials: { apiKey: "bad" } };
  const result = await claude.checkAuth(
    state,
    context(async (input, init) => {
      assert.equal(String(input), "https://api.anthropic.com/v1/models?limit=1");
      assert.equal(new Headers(init?.headers).get("x-api-key"), "bad");
      return new Response(null, { status: 401 });
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "auth-required");
  }
});

test("Claude request preparation avoids profile checks and can force token rotation", async () => {
  const fresh: CredentialState = {
    ...oauth,
    credentials: {
      ...oauth.credentials,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
  const offline = context(async () => {
    throw new Error("Unexpected preparation network request");
  });
  assert.equal((await claude.checkAuth(fresh, offline, { validate: false })).ok, true);
  assert.equal(
    (
      await claude.checkAuth({ ...fresh, credentials: { apiKey: "secret" } }, offline, {
        validate: false,
      })
    ).ok,
    true,
  );
  let calls = 0;
  const forced = await claude.checkAuth(
    fresh,
    context(async (_input, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).grant_type, "refresh_token");
      return Response.json({ access_token: "rotated", refresh_token: "next", expires_in: 3600 });
    }),
    { validate: false, forceRefresh: true },
  );
  assert.equal(calls, 1);
  assert.equal(forced.ok && forced.value.credentials.accessToken, "rotated");
});
