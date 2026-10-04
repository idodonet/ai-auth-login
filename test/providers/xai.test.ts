import assert from "node:assert/strict";
import test from "node:test";
import { xai } from "../../src/providers/xai/index.js";
import type { ProviderContext, CredentialState } from "../../src/providers/contract.js";
import { ProviderSession } from "../../src/session.js";
import { encodeState } from "../../src/state.js";
const context = (fetch: typeof globalThis.fetch): ProviderContext => ({
  fetch,
  signal: new AbortController().signal,
});

test("xAI refresh distinguishes throttling and configuration errors from revoked grants", async () => {
  const state: CredentialState = {
    provider: "xai",
    authenticatedAt: null,
    credentials: {
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt: 0,
      tokenEndpoint: "https://auth.x.ai/token",
    },
  };
  for (const [status, body, code, retryable] of [
    [429, { error: "temporarily_unavailable" }, "rate-limited", true],
    [500, { error: "server_error" }, "provider-error", true],
    [400, { error: "invalid_client" }, "provider-error", false],
  ] as const) {
    const session = new ProviderSession({
      state: encodeState(state),
      fetch: async () => Response.json(body, { status }),
    });
    try {
      const result = await session.checkAuth();
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, code);
        assert.equal(result.error.retryable, retryable);
      }
    } finally {
      await session.close();
    }
  }
  const result = await xai.checkAuth(
    state,
    context(async () => Response.json({ error: "invalid_grant" }, { status: 400 })),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "auth-required");
});
test("xAI discovery rejects credential endpoints outside x.ai", async () => {
  let calls = 0;
  const result = await xai.beginAuth(
    context(async () => {
      calls++;
      return Response.json({
        device_authorization_endpoint: "https://auth.x.ai.attacker.test/device",
        token_endpoint: "https://auth.x.ai/token",
      });
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});
test("xAI refresh rotates credentials without changing authentication time", async () => {
  const state: CredentialState = {
    provider: "xai",
    authenticatedAt: "2026-01-01T00:00:00Z",
    credentials: {
      accessToken: "expired",
      refreshToken: "old-refresh",
      expiresAt: 1,
      tokenEndpoint: "https://auth.x.ai/token",
    },
  };
  const result = await xai.checkAuth(
    state,
    context(async (url, init) => {
      assert.equal(url, "https://auth.x.ai/token");
      assert.equal(init?.redirect, "error");
      assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "old-refresh");
      return Response.json({
        access_token: "new",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.credentials.refreshToken, "new-refresh");
    assert.equal(result.value.authenticatedAt, state.authenticatedAt);
  }
});
test("xAI OAuth requests use CLI proxy and required headers", async () => {
  const state: CredentialState = {
    provider: "xai",
    authenticatedAt: null,
    credentials: { accessToken: "oauth" },
  };
  const response = await xai.execute(
    new Request("http://internal/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "grok-4.7", input: "hello" }),
    }),
    state,
    context(async (url, init) => {
      assert.equal(url, "https://cli-chat-proxy.grok.com/v1/responses");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer oauth");
      assert.equal(headers.get("x-grok-client-version"), "1.0.44");
      assert.equal(headers.get("X-XAI-Token-Auth"), "xai-grok-cli");
      return Response.json({ object: "response", output: [] });
    }),
  );
  assert.equal(response.status, 200);
});
test("xAI refresh rejects tampered stored endpoint before transmitting refresh token", async () => {
  const state: CredentialState = {
    provider: "xai",
    authenticatedAt: null,
    credentials: {
      accessToken: "old",
      refreshToken: "secret",
      expiresAt: 0,
      tokenEndpoint: "https://evil.test/token",
    },
  };
  let calls = 0;
  const result = await xai.checkAuth(
    state,
    context(async () => {
      calls++;
      return Response.json({});
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});
test("xAI reports provider ID-token metadata and preserves identity on refresh", async () => {
  const idToken = `header.${Buffer.from(JSON.stringify({ sub: "account-123", email: "user@example.test" })).toString("base64url")}.signature`;
  const initial: CredentialState = {
    provider: "xai",
    authenticatedAt: "2026-01-01T00:00:00Z",
    credentials: {
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt: 0,
      tokenEndpoint: "https://auth.x.ai/token",
    },
  };
  const minted = await xai.checkAuth(
    initial,
    context(async () =>
      Response.json({ access_token: "new", expires_in: 3600, id_token: idToken }),
    ),
    { forceRefresh: true },
  );
  assert.equal(minted.ok, true);
  if (!minted.ok) {
    return;
  }
  const account = await xai.getAccount(minted.value, context(globalThis.fetch));
  assert.equal(account.ok, true);
  if (account.ok) {
    assert.equal(account.value?.id, "account-123");
    assert.equal(account.value?.email, "user@example.test");
  }
  const refreshed = await xai.checkAuth(
    minted.value,
    context(async () => Response.json({ access_token: "next", expires_in: 3600 })),
    { forceRefresh: true },
  );
  assert.equal(refreshed.ok, true);
  if (refreshed.ok) {
    assert.equal(refreshed.value.credentials.idToken, idToken);
    assert.equal(refreshed.value.credentials.subject, "account-123");
    assert.equal(refreshed.value.credentials.email, "user@example.test");
    assert.equal(refreshed.value.authenticatedAt, initial.authenticatedAt);
  }
});
