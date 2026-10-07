import test from "node:test";
import assert from "node:assert/strict";
import { codex } from "../../src/providers/codex/index.js";
import type { CredentialState, ProviderContext } from "../../src/providers/contract.js";
const state: CredentialState = {
  provider: "codex",
  authenticatedAt: "2026-01-01T00:00:00Z",
  credentials: { access_token: "old", refresh_token: "refresh", expiresAt: 1 },
};
function context(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ProviderContext {
  return {
    signal: new AbortController().signal,
    fetch: (async (url, init) => handler(String(url), init)) as typeof fetch,
  };
}
test("Codex refresh rotates tokens and preserves login time; revoked credentials report auth-required", async () => {
  const refreshed = await codex.checkAuth(
    state,
    context((url, init) => {
      assert.equal(url, "https://auth.openai.com/oauth/token");
      assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "refresh");
      return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
    }),
  );
  assert.ok(refreshed.ok);
  assert.equal(refreshed.value.credentials.refresh_token, "rotated");
  assert.equal(refreshed.value.authenticatedAt, state.authenticatedAt);
  const revoked = await codex.checkAuth(
    state,
    context(() => Response.json({ error: "invalid_grant" }, { status: 400 })),
  );
  assert.ok(!revoked.ok);
  assert.equal(revoked.error.code, "auth-required");
});
test("Codex callback rejects mismatched state without exchange and completes idempotently", async () => {
  let calls = 0;
  const login = await codex.beginAuth(
    context(() => {
      calls++;
      return Response.json({ access_token: "new", refresh_token: "r", expires_in: 3600 });
    }),
  );
  assert.ok(login.ok);
  assert.equal(login.value.kind, "callback");
  if (login.value.kind !== "callback") {
    return;
  }
  const bad = await login.value.complete("http://localhost:1455/auth/callback?code=c&state=wrong");
  assert.ok(!bad.ok);
  assert.equal(bad.error.code, "invalid-callback");
  assert.equal(calls, 0);
  const callback = `http://localhost:1455/auth/callback?code=c&state=${new URL(login.value.url).searchParams.get("state")}`;
  assert.ok((await login.value.complete(callback)).ok);
  assert.ok((await login.value.complete(callback)).ok);
  assert.equal(calls, 1);
});
test("Codex device completes exchange and cancellation returns structured failure", async () => {
  const login = await codex.beginAuth(
    context((url) =>
      url.endsWith("/usercode")
        ? Response.json({ device_auth_id: "d", user_code: "U", interval: 5 })
        : url.endsWith("/deviceauth/token")
          ? Response.json({ authorization_code: "c", code_verifier: "v" })
          : Response.json({ access_token: "a", expires_in: 3600 }),
    ),
    { method: "device" },
  );
  assert.ok(login.ok);
  assert.equal(login.value.kind, "device");
  if (login.value.kind !== "device") {
    return;
  }
  assert.ok((await login.value.wait()).ok);
  const cancelled = await codex.beginAuth(context(() => Response.json({})));
  assert.ok(cancelled.ok);
  cancelled.value.cancel();
  if (cancelled.value.kind === "callback") {
    const result = await cancelled.value.complete("invalid");
    assert.ok(!result.ok);
    assert.equal(result.error.code, "cancelled");
  }
});
test("Codex quota normalizes weekly and extra model limits; models use provider catalog", async () => {
  const ctx = context((url) =>
    url.includes("/wham/usage")
      ? Response.json({
          rate_limit: {
            secondary_window: {
              used_percent: 25,
              limit_window_seconds: 604800,
              reset_at: 1800000000,
            },
          },
          additional_rate_limits: [
            {
              limit_name: "spark",
              rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } },
            },
          ],
        })
      : Response.json({ models: [{ slug: "gpt-codex" }] }),
  );
  const quota = await codex.getQuota(state, ctx);
  assert.ok(quota.ok);
  assert.equal(quota.value.windows[0]?.remainingPercent, 75);
  assert.equal(quota.value.windows[0]?.name, "weekly");
  assert.equal(quota.value.windows[1]?.model, "spark");
  const models = await codex.listModels(state, ctx);
  assert.ok(models.ok);
  assert.equal(models.value[0]?.id, "gpt-codex");
});
test("Codex responses enforce native restrictions and recover nonstream SSE", async () => {
  const response = await codex.execute(
    new Request("https://internal/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "m", input: "hello", max_output_tokens: 100 }),
    }),
    state,
    context((url, init) => {
      assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(body.instructions, "");
      assert.equal(body.max_output_tokens, undefined);
      return new Response(
        'data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }),
  );
  assert.equal((await response.json()).id, "resp_1");
});
test("Codex collects required SSE without relying on content-type for either SDK endpoint", async () => {
  for (const contentType of [undefined, "text/plain", "application/json", "text/event-stream"]) {
    for (const path of ["/responses", "/chat/completions"]) {
      const response = await codex.execute(
        new Request(`https://internal/v1${path}`, {
          method: "POST",
          body: JSON.stringify({
            model: "gpt-6.1-sol",
            ...(path === "/responses"
              ? { input: 'Say "1"' }
              : {
                  messages: [{ role: "user", content: 'Say "1"' }],
                  max_completion_tokens: 1,
                  reasoning_effort: "low",
                }),
          }),
        }),
        state,
        context((_url, init) => {
          const body = JSON.parse(String(init?.body));
          assert.equal(body.stream, true);
          assert.equal(body.max_output_tokens, undefined);
          return new Response(
            new TextEncoder().encode(
              'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-6.1-sol","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"1"}]}]}}\n\n',
            ),
            {
              headers: {
                ...(contentType ? { "content-type": contentType } : {}),
                "x-request-id": "request-1",
              },
            },
          );
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-request-id"), "request-1");
      const body = await response.json();
      assert.equal(
        path === "/responses" ? body.output[0].content[0].text : body.choices[0].message.content,
        "1",
      );
    }
  }
});
test("Codex fresh token force refresh rotates once; explicit validation detects revocation", async () => {
  const fresh = {
    ...state,
    credentials: { ...state.credentials, expiresAt: Date.now() + 3600_000 },
  };
  let calls = 0;
  const ctx = context((url) => {
    calls++;
    return url.endsWith("/oauth/token")
      ? Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 })
      : Response.json({}, { status: 401 });
  });
  assert.ok((await codex.checkAuth(fresh, ctx, { validate: false })).ok);
  assert.equal(calls, 0);
  const forced = await codex.checkAuth(fresh, ctx, { forceRefresh: true, validate: false });
  assert.ok(forced.ok);
  assert.equal(forced.value.credentials.refresh_token, "rotated");
  assert.equal(calls, 1);
  const revoked = await codex.checkAuth(fresh, ctx, { validate: true });
  assert.ok(!revoked.ok);
  assert.equal(revoked.error.code, "auth-required");
});
test("Codex validates configured and restored endpoint before credential transmission", async () => {
  for (const baseURL of [
    "http://remote.example",
    "https://u:p@example.com",
    "https://example.com?key=x",
    "https://example.com/#x",
    "ftp://example.com",
  ]) {
    assert.ok(
      !(
        await codex.connect(
          { kind: "api-key", apiKey: "secret", baseURL },
          context(() => {
            throw Error("network forbidden");
          }),
        )
      ).ok,
    );
    const restored = { ...state, credentials: { ...state.credentials, baseURL } };
    const result = await codex.checkAuth(
      restored,
      context(() => {
        throw Error("network forbidden");
      }),
      { validate: false },
    );
    assert.ok(!result.ok);
    assert.equal(result.error.code, "invalid-state");
    const models = await codex.listModels(
      restored,
      context(() => {
        throw Error("network forbidden");
      }),
    );
    assert.ok(!models.ok);
    assert.equal(models.error.code, "invalid-state");
  }
  assert.ok(
    (
      await codex.connect(
        { kind: "api-key", apiKey: "secret", baseURL: "http://127.0.0.1:5555/" },
        context(() => Response.json({})),
      )
    ).ok,
  );
});
test("Codex forwards supported caller metadata while keeping provider credentials fixed", async () => {
  const jwt = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "real-account" } })).toString("base64url")}.x`;
  const accountState = { ...state, credentials: { ...state.credentials, id_token: jwt } };
  const metadata = {
    version: "0.159.0",
    "x-codex-beta-features": "images",
    "x-codex-turn-metadata": "{}",
    "x-codex-turn-state": "s",
    "x-client-request-id": "client",
    "x-request-id": "request",
    "thread-id": "thread",
    "session-id": "session",
  };
  for (const path of ["/responses", "/chat/completions", "/images/generations"]) {
    const body =
      path === "/chat/completions"
        ? { model: "m", messages: [{ role: "user", content: "hello" }] }
        : path === "/images/generations"
          ? { model: "gpt-image-2", prompt: "draw" }
          : { model: "m", input: "hello" };
    const request = new Request(`https://internal/v1${path}`, {
      method: "POST",
      headers: {
        ...metadata,
        "content-type": "application/json",
        authorization: "Bearer attacker",
        "chatgpt-account-id": "attacker",
        "user-agent": "attacker",
      },
      body: JSON.stringify(body),
    });
    await codex.execute(
      request,
      accountState,
      context((url, init) => {
        const h = new Headers(init?.headers);
        for (const [key, value] of Object.entries(metadata)) {
          assert.equal(h.get(key), value);
        }
        assert.equal(h.get("authorization"), "Bearer old");
        assert.equal(h.get("chatgpt-account-id"), "real-account");
        assert.notEqual(h.get("user-agent"), "attacker");
        if (url.endsWith("/images/generations")) {
          return Response.json({ data: [{ b64_json: "a" }] });
        }
        return new Response(
          'data: {"type":"response.completed","response":{"id":"r","output":[]}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
  }
});
