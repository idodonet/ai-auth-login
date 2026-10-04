import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { gemini } from "../../src/providers/gemini/index.js";
import { vertex } from "../../src/providers/vertex/index.js";
const controller = new AbortController();
const context = { signal: controller.signal, fetch: globalThis.fetch };
test("Google imports reject arbitrary token endpoints and non-RSA keys", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const account = {
    type: "service_account",
    client_email: "test@example.iam.gserviceaccount.com",
    project_id: "test-project",
    private_key: rsa,
  };
  assert.equal(
    (
      await vertex.connect(
        {
          kind: "service-account",
          serviceAccount: { ...account, token_uri: "https://evil.example/token" },
        },
        context,
      )
    ).ok,
    false,
  );
  const connected = await vertex.connect(
    { kind: "service-account", serviceAccount: account },
    context,
  );
  assert.equal(connected.ok, true);
  if (!connected.ok) {
    return;
  }
  let exchangeCount = 0;
  const mocked = {
    ...context,
    fetch: (async (url, init) => {
      exchangeCount++;
      assert.equal(String(url), "https://oauth2.googleapis.com/token");
      const assertion = (init?.body as URLSearchParams).get("assertion")!;
      const payload = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString());
      assert.equal(payload.iss, account.client_email);
      return Response.json({ access_token: "token", expires_in: 3600 });
    }) as typeof fetch,
  };
  const refreshed = await vertex.checkAuth(connected.value, mocked);
  assert.equal(refreshed.ok, true);
  if (refreshed.ok) {
    await vertex.checkAuth(refreshed.value, mocked);
  }
  assert.equal(exchangeCount, 1);
  for (const [status, error, code, retryable] of [
    [429, "rate", "rate-limited", true],
    [400, "invalid_grant", "auth-required", false],
    [400, "invalid_request", "provider-error", false],
  ] as const) {
    const result = await vertex.checkAuth(connected.value, {
      ...context,
      fetch: (async () => Response.json({ error }, { status })) as typeof fetch,
    });
    assert.ok(!result.ok);
    assert.equal(result.error.code, code);
    assert.equal(result.error.retryable, retryable);
  }

  if (refreshed.ok) {
    await vertex.checkAuth(refreshed.value, mocked, { forceRefresh: true });
    assert.equal(exchangeCount, 2);
  }
});
test("Gemini discovers models across pages and rejects invalid credentials", async () => {
  assert.equal(
    (
      await gemini.connect(
        { kind: "api-key", apiKey: "", baseURL: "https://evil.example" },
        context,
      )
    ).ok,
    false,
  );
  const connected = await gemini.connect({ kind: "api-key", apiKey: "key" }, context);
  assert.equal(connected.ok, true);
  if (!connected.ok) {
    return;
  }
  let count = 0;
  const result = await gemini.listModels(connected.value, {
    ...context,
    fetch: (async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "key");
      count++;
      return Response.json({
        models: [
          { name: `models/gemini-${count}`, supportedGenerationMethods: ["generateContent"] },
        ],
        ...(count === 1 ? { nextPageToken: "page-two" } : {}),
      });
    }) as typeof fetch,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.value.map((model) => model.id),
      ["gemini-1", "gemini-2"],
    );
  }
});
test("Vertex execution translates a consumed SDK request without rereading it", async () => {
  const connected = await vertex.connect({ kind: "api-key", apiKey: "key" }, context);
  assert.equal(connected.ok, true);
  if (!connected.ok) {
    return;
  }
  const response = await vertex.execute(
    new Request("https://internal/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
    connected.value,
    {
      ...context,
      fetch: (async (url, init) => {
        assert.equal(
          String(url),
          "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent",
        );
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, undefined);
        assert.equal(body.stream, undefined);
        assert.equal(body.contents[0].parts[0].text, "hello");
        return Response.json({
          candidates: [
            { content: { parts: [{ text: "hi" }], role: "model" }, finishReason: "STOP" },
          ],
        });
      }) as typeof fetch,
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "hi");
});
