import assert from "node:assert/strict";
import test from "node:test";
import { ProviderSession } from "../src/session.js";
import { decodeState, encodeState } from "../src/state.js";
import type { CredentialState } from "../src/providers/contract.js";

const authFetch: typeof globalThis.fetch = async () => Response.json({ models: [] });
const state = (expired = false): CredentialState => ({
  provider: "codex",
  authenticatedAt: "2026-01-01T00:00:00.000Z",
  credentials: {
    access_token: "old",
    refresh_token: "refresh",
    expiresAt: expired ? 0 : Date.now() + 3600_000,
  },
});

test("restored state is validated; close preserves it and removes listeners", async () => {
  assert.equal(decodeState('{"version":88}').ok, false);
  assert.equal(
    decodeState('{"version":1,"provider":"unknown","credentials":{},"authenticatedAt":null}').ok,
    false,
  );
  const session = new ProviderSession({ state: encodeState(state()), fetch: authFetch });
  assert.equal(session.provider, "codex");
  assert.deepEqual(await session.checkAuth(), { ok: true, value: { valid: true } });
  const saved = session.exportState();
  let events = 0;
  session.onStateChange(() => events++);
  await session.close();
  await session.close();
  assert.equal(session.exportState(), saved);
  assert.equal(events, 0);
  assert.deepEqual(await session.checkAuth(), {
    ok: false,
    error: { code: "closed", message: "Session is closed.", retryable: false },
  });
});

test("single-flight refresh emits once and old refresh cannot restore logged-out state", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  let resolve!: (response: Response) => void;
  globalThis.fetch = async (input) => {
    if (!String(input).includes("oauth/token")) {
      return Response.json({ models: [] });
    }
    calls++;
    return new Promise<Response>((done) => {
      resolve = done;
    });
  };
  try {
    const session = new ProviderSession({ state: encodeState(state(true)) });
    let events = 0;
    session.onStateChange(() => {
      events++;
      throw new Error("storage failed");
    });
    const first = session.checkAuth();
    const second = session.checkAuth();
    assert.equal(calls, 1);
    resolve(Response.json({ access_token: "new", expires_in: 3600 }));
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.equal(events, 1);
    assert.equal(JSON.parse(session.exportState()!).credentials.access_token, "new");
    await session.close();
    const late = new ProviderSession({ state: encodeState(state(true)) });
    const pending = late.checkAuth();
    await late.logout();
    resolve(Response.json({ access_token: "too-late", expires_in: 3600 }));
    assert.equal((await pending).ok, false);
    assert.equal(late.exportState(), null);
    await late.close();
  } finally {
    globalThis.fetch = original;
  }
});

test("SDK models use adapter discovery; supplied fetch, auth ownership and SDK generation", async () => {
  const session = new ProviderSession({ state: encodeState(state()), fetch: authFetch });
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname.endsWith("/models")) {
      return Response.json({ models: [{ slug: "test-model", display_name: "Test" }] });
    }
    return new Response(
      'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","output":[]}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const made = await session.createSDK({
    fetch,
    maxRetries: 0,
    defaultHeaders: { authorization: "Bearer override" },
  });
  assert.equal(made.ok, true);
  if (!made.ok) {
    return;
  }
  const models = await made.value.models.list();
  assert.equal(models.data[0]?.id, "test-model");
  assert.equal(session.getStats().requestsSent, 0);
  await made.value.responses.create(
    { model: "test-model", input: "hello" },
    { headers: { authorization: "Bearer attacker", "x-api-key": "attacker" } },
  );
  assert.equal(session.getStats().requestsSent, 1);
  const generationRequest = requests.at(-1)!;
  assert.equal(generationRequest.headers.get("authorization"), "Bearer old");
  assert.equal(generationRequest.headers.get("x-api-key"), null);
  await session.logout();
  const before = requests.length;
  await assert.rejects(made.value.models.list());
  assert.equal(requests.length, before);
  await session.close();
});

test("401 rotates OAuth credentials once, retries once and persists the new token", async () => {
  let inference = 0;
  let refreshes = 0;
  const seen: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.includes("oauth/token")) {
      refreshes++;
      return Response.json({ access_token: "rotated", expires_in: 3600 });
    }
    if (new URL(request.url).pathname.endsWith("/models")) {
      return Response.json({ models: [] });
    }
    inference++;
    seen.push(request.headers.get("authorization")!);
    if (inference === 1) {
      return Response.json({ error: { message: "expired" } }, { status: 401 });
    }
    return new Response(
      'data: {"type":"response.completed","response":{"id":"resp_ok","object":"response","output":[]}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const session = new ProviderSession({ state: encodeState(state()), fetch });
  const sdk = await session.createSDK({ maxRetries: 0 });
  assert.equal(sdk.ok, true);
  if (!sdk.ok) {
    return;
  }
  let changes = 0;
  session.onStateChange(() => changes++);
  await sdk.value.responses.create({ model: "test", input: "hello" });
  assert.deepEqual(seen, ["Bearer old", "Bearer rotated"]);
  assert.equal(refreshes, 1);
  assert.equal(changes, 1);
  assert.equal(session.getStats().requestsSent, 2);
  assert.equal(session.getStats().requestsFailed, 1);
  assert.equal(JSON.parse(session.exportState()!).credentials.access_token, "rotated");
  await session.close();
});

test("closing inside a state listener stops dispatch and preserves committed state", async () => {
  const session = new ProviderSession();
  let later = 0;
  session.onStateChange(() => {
    void session.close();
  });
  session.onStateChange(() => {
    later++;
  });
  assert.equal(
    (
      await session.connect("openai-compatibility", {
        kind: "api-key",
        apiKey: "secret",
        baseURL: "https://upstream.invalid/v1",
      })
    ).ok,
    true,
  );
  assert.equal(later, 0);
  assert.equal(session.provider, "openai-compatibility");
  assert.ok(session.exportState());
  assert.equal((await session.checkAuth()).ok, false);
});

test("logout inside a state listener does not persist the superseded credentials", async () => {
  const session = new ProviderSession();
  const saved: (string | null)[] = [];
  session.onStateChange((state) => {
    if (state !== null) {
      void session.logout();
    }
  });
  session.onStateChange((state) => saved.push(state));
  await session.connect("openai-compatibility", {
    kind: "api-key",
    apiKey: "synthetic",
    baseURL: "https://upstream.invalid/v1",
  });
  assert.deepEqual(saved, [null]);
  assert.equal(session.exportState(), null);
  await session.close();
});

test("refresh rotation is persisted even when subsequent validation fails", async () => {
  const refreshTokens: unknown[] = [];
  const session = new ProviderSession({
    state: encodeState(state(true)),
    fetch: async (input, init) => {
      if (String(input).includes("oauth/token")) {
        refreshTokens.push(new URLSearchParams(String(init?.body)).get("refresh_token"));
        return Response.json({
          access_token: "rotated",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        });
      }
      return Response.json({ error: "temporary" }, { status: 503 });
    },
  });
  const checked = await session.checkAuth();
  assert.equal(checked.ok, false);
  assert.deepEqual(refreshTokens, ["refresh"]);
  assert.equal(JSON.parse(session.exportState()!).credentials.refresh_token, "rotated-refresh");
  assert.equal((await session.checkAuth()).ok, false);
  assert.equal((await session.getAccount()).ok, true);
  assert.deepEqual(refreshTokens, ["refresh"]);
  await session.close();
});
