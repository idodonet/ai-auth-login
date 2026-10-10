import assert from "node:assert/strict";
import test from "node:test";
import { antigravity } from "../../src/providers/antigravity/index.js";
import type { CredentialState, ProviderContext } from "../../src/providers/contract.js";

const state: CredentialState = {
  provider: "antigravity",
  authenticatedAt: "2026-01-01T00:00:00Z",
  credentials: {
    accessToken: "old-token",
    refreshToken: "refresh",
    expiresAt: "2020-01-01T00:00:00Z",
    project: "project",
    email: "a@example.test",
    plan: "free-tier",
  },
};
function context(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ProviderContext {
  return {
    signal: new AbortController().signal,
    fetch: (async (input, init) => handler(String(input), init)) as typeof fetch,
  };
}

test("Antigravity callback binds state, exchanges credentials, discovers project and account", async () => {
  const calls: string[] = [];
  const ctx = context((url, init) => {
    calls.push(url);
    if (url.includes("/token")) {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.ok(form.get("code_verifier"));
      return Response.json({ access_token: "token", refresh_token: "refresh", expires_in: 3600 });
    }
    if (url.includes("userinfo")) {
      return Response.json({ id: "account", email: "a@example.test" });
    }
    return Response.json({
      cloudaicompanionProject: { id: "project" },
      currentTier: { id: "free-tier" },
    });
  });
  const started = await antigravity.beginAuth(ctx);
  assert.ok(started.ok);
  assert.equal(started.value.kind, "callback");
  if (started.value.kind !== "callback") {
    return;
  }
  const authURL = new URL(started.value.url);
  const callback = new URL(authURL.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "code");
  callback.searchParams.set("state", "wrong");
  assert.equal((await started.value.complete(callback.toString())).ok, false);
  assert.equal(calls.length, 0);
  callback.searchParams.set("state", authURL.searchParams.get("state")!);
  const result = await started.value.complete(callback.toString());
  assert.ok(result.ok);
  assert.equal(result.value.credentials.project, "project");
  assert.equal(result.value.credentials.email, "a@example.test");
  assert.equal(result.value.provider, "antigravity");
  started.value.cancel();
});

test("Antigravity refresh preserves rotating credentials and rejects malformed state", async () => {
  const ctx = context((url, init) => {
    assert.equal(url, "https://oauth2.googleapis.com/token");
    assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "refresh");
    return Response.json({ access_token: "new-token", expires_in: 3600 });
  });
  const refreshed = await antigravity.checkAuth(state, ctx);
  assert.ok(refreshed.ok);
  assert.equal(refreshed.value.credentials.refreshToken, "refresh");
  assert.equal(refreshed.value.credentials.accessToken, "new-token");
  assert.equal(refreshed.value.authenticatedAt, state.authenticatedAt);
  assert.equal((await antigravity.checkAuth({ ...state, credentials: {} }, ctx)).ok, false);
  const account = await antigravity.getAccount(state, ctx);
  assert.ok(account.ok);
  assert.equal(account.value?.isFree, true);
});

test("Antigravity models use the live map and quota uses the quota summary", async () => {
  const ctx = context((url) => {
    if (url.endsWith(":retrieveUserQuotaSummary"))
      return Response.json({
        groups: [
          {
            displayName: "Gemini",
            buckets: [
              { window: "weekly", remainingFraction: 0, resetTime: "2026-10-17T00:00:00Z" },
            ],
          },
        ],
      });
    assert.ok(url.endsWith(":fetchAvailableModels"));
    return Response.json({ models: { "gemini-model": { displayName: "Gemini" } } });
  });
  const models = await antigravity.listModels(state, ctx);
  assert.ok(models.ok);
  assert.equal(models.value[0]?.id, "gemini-model");
  const quota = await antigravity.getQuota(state, ctx);
  assert.ok(quota.ok);
  assert.equal(quota.value.supported, true);
  assert.equal(quota.value.windows[0].remainingPercent, 0);
  assert.equal(quota.value.windows[0].durationSeconds, 604800);
});

test("Antigravity wraps native Gemini requests and unwraps responses", async () => {
  const ctx = context((url, init) => {
    assert.ok(url.endsWith(":generateContent"));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.project, "project");
    assert.equal(body.model, "gemini-model");
    assert.equal(body.requestType, "agent");
    assert.equal(body.request.model, undefined);
    assert.ok(body.request.contents);
    return Response.json({
      response: { candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }] },
    });
  });
  const response = await antigravity.execute(
    new Request("https://internal.invalid/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-model", messages: [{ role: "user", content: "Hi" }] }),
    }),
    state,
    ctx,
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.choices[0].message.content, "hello");
});

test("Antigravity onboards missing projects and does not expose provider error bodies", async () => {
  const ctx = context((url, init) => {
    if (url.includes("/token")) {
      return Response.json({ access_token: "token", refresh_token: "refresh", expires_in: 3600 });
    }
    if (url.includes("userinfo")) {
      return Response.json({ email: "a@example.test" });
    }
    if (url.endsWith(":loadCodeAssist")) {
      return Response.json({ allowedTiers: [{ id: "paid-tier", isDefault: true }] });
    }
    assert.ok(url.endsWith(":onboardUser"));
    assert.equal(JSON.parse(String(init?.body)).tier_id, "paid-tier");
    return Response.json({ done: true, response: { projectId: "onboarded-project" } });
  });
  const login = await antigravity.beginAuth(ctx);
  assert.ok(login.ok);
  assert.equal(login.value.kind, "callback");
  if (login.value.kind !== "callback") {
    return;
  }
  const url = new URL(login.value.url),
    callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", url.searchParams.get("state")!);
  callback.searchParams.set("code", "code");
  const completed = await login.value.complete(callback.toString());
  assert.ok(completed.ok);
  assert.equal(completed.value.credentials.project, "onboarded-project");
  const failed = await antigravity.checkAuth(
    state,
    context(() => new Response("secret-token", { status: 401 })),
  );
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.error.code, "auth-required");
    assert.ok(!failed.error.message.includes("secret-token"));
  }
});

test("Antigravity preserves streaming envelopes for incremental translation", async () => {
  const ctx = context((url, init) => {
    assert.ok(url.endsWith(":streamGenerateContent?alt=sse"));
    assert.equal(JSON.parse(String(init?.body)).requestType, "agent");
    return new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}]}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const response = await antigravity.execute(
    new Request("https://internal.invalid/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-model",
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
      }),
    }),
    state,
    ctx,
  );
  const result = await response.text();
  assert.ok(result.includes('"content":"hello"'));
  assert.ok(result.includes("[DONE]"));
});

test("Antigravity rechecks completed onboarding once and preserves lookup failures", async () => {
  for (const outcome of ["project", "missing", "auth", "network"] as const) {
    let loads = 0;
    let onboards = 0;
    let firstLookup: RequestInit | undefined;
    const ctx = context((url, init) => {
      if (url.includes("/token")) {
        return Response.json({ access_token: "token", refresh_token: "refresh", expires_in: 3600 });
      }
      if (url.includes("userinfo")) {
        return Response.json({ email: "a@example.test" });
      }
      if (url.endsWith(":loadCodeAssist")) {
        assert.equal(url, "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
        if (++loads === 1) {
          firstLookup = init;
          return Response.json({});
        }
        assert.equal(init?.body, firstLookup?.body);
        assert.deepEqual(init?.headers, firstLookup?.headers);
        if (outcome === "network") throw new Error("private network details");
        if (outcome === "auth") return new Response("private auth details", { status: 403 });
        return Response.json(
          outcome === "project" ? { cloudaicompanionProject: { id: "recovered" } } : {},
        );
      }
      assert.ok(url.endsWith(":onboardUser"));
      onboards++;
      return Response.json({ done: true, response: {} });
    });
    const login = await antigravity.beginAuth(ctx);
    assert.ok(login.ok && login.value.kind === "callback");
    const url = new URL(login.value.url);
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("code", "code");
    const completed = await login.value.complete(callback.toString());
    assert.equal(loads, 2);
    assert.equal(onboards, 1);
    if (outcome === "project") {
      assert.ok(completed.ok);
      assert.equal(completed.value.credentials.project, "recovered");
    } else {
      assert.ok(!completed.ok);
      assert.equal(
        completed.error.code,
        outcome === "auth"
          ? "auth-required"
          : outcome === "network"
            ? "network-error"
            : "provider-error",
      );
      assert.equal(completed.error.retryable, outcome === "network");
      assert.ok(!completed.error.message.includes("private"));
      if (outcome === "missing") {
        assert.match(
          completed.error.message,
          /official Antigravity app.*same Google account.*fresh login/,
        );
      }
    }
  }
});

test("Antigravity cancellation stops pending onboarding without another lookup", async () => {
  const controller = new AbortController();
  let loads = 0;
  let onboards = 0;
  const ctx = context((url) => {
    if (url.includes("/token"))
      return Response.json({ access_token: "token", refresh_token: "refresh", expires_in: 3600 });
    if (url.includes("userinfo")) return Response.json({ email: "a@example.test" });
    if (url.endsWith(":loadCodeAssist")) {
      loads++;
      return Response.json({});
    }
    onboards++;
    controller.abort();
    return Response.json({ done: false });
  });
  ctx.signal = controller.signal;
  const login = await antigravity.beginAuth(ctx);
  assert.ok(login.ok && login.value.kind === "callback");
  const url = new URL(login.value.url);
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", url.searchParams.get("state")!);
  callback.searchParams.set("code", "code");
  const completed = await login.value.complete(callback.toString());
  assert.ok(!completed.ok);
  assert.equal(completed.error.code, "cancelled");
  assert.equal(loads, 1);
  assert.equal(onboards, 1);
});
