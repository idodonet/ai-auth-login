import test from "node:test";
import assert from "node:assert/strict";
import { xai } from "../../src/providers/xai/index.js";
import type { CredentialState, ProviderContext } from "../../src/providers/contract.js";
const state: CredentialState = {
  provider: "xai",
  authenticatedAt: null,
  credentials: { apiKey: "secret" },
};
const ctx = (fetch: typeof globalThis.fetch): ProviderContext => ({
  fetch,
  signal: new AbortController().signal,
});
test("SDK multipart video creation maps generation and metadata", async () => {
  const body = new FormData();
  body.set("model", "sora-2");
  body.set("prompt", "A cat");
  body.set("seconds", "20");
  body.set("size", "1280x720");
  const response = await xai.execute(
    new Request("http://internal/v1/videos", {
      method: "POST",
      body,
      headers: { "x-idempotency-key": "video-operation-1" },
    }),
    state,
    ctx(async (url, options) => {
      assert.equal(url, "https://api.x.ai/v1/videos/generations");
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer secret");
      assert.equal(new Headers(options?.headers).get("x-idempotency-key"), "video-operation-1");
      assert.deepEqual(JSON.parse(String(options?.body)), {
        model: "grok-imagine-video",
        prompt: "A cat",
        duration: 15,
        aspect_ratio: "16:9",
        resolution: "720p",
      });
      return Response.json({ request_id: "video1", status: "pending" });
    }),
  );
  const data = await response.json();
  assert.equal(data.id, "video1");
  assert.equal(data.status, "queued");
  assert.equal(data.seconds, "15");
});
test("SDK video retrieve maps completion and duration", async () => {
  const response = await xai.execute(
    new Request("http://internal/v1/videos/video1"),
    state,
    ctx(async (url) => {
      assert.equal(url, "https://api.x.ai/v1/videos/video1");
      return Response.json({
        status: "done",
        video: { duration: 4, url: "https://assets.grok.com/video.mp4" },
      });
    }),
  );
  const data = await response.json();
  assert.equal(data.status, "completed");
  assert.equal(data.seconds, "4");
});
test("SDK video content downloads media without credentials", async () => {
  let calls = 0;
  const response = await xai.execute(
    new Request("http://internal/v1/videos/video1/content"),
    state,
    ctx(async (url, options) => {
      if (calls++ === 0) {
        return Response.json({ video: { url: "https://assets.grok.com/video.mp4" } });
      }
      assert.equal(String(url), "https://assets.grok.com/video.mp4");
      assert.equal(options?.headers, undefined);
      assert.equal(options?.redirect, "error");
      return new Response("media", { headers: { "Content-Type": "video/mp4" } });
    }),
  );
  assert.equal(await response.text(), "media");
  assert.equal(response.headers.get("content-type"), "video/mp4");
});
test("SDK video content rejects arbitrary or credential-bearing media URLs", async () => {
  for (const url of [
    "https://attacker.test/media",
    "https://secret@assets.grok.com/media",
    "http://assets.grok.com/media",
  ]) {
    let calls = 0;
    const response = await xai.execute(
      new Request("http://internal/v1/videos/video1/content"),
      state,
      ctx(async () => {
        calls++;
        return Response.json({ video: { url } });
      }),
    );
    assert.equal(response.status, 502);
    assert.equal(calls, 1);
  }
});
test("xAI validation can skip API-key probe and force OAuth rotation", async () => {
  const result = await xai.checkAuth(
    state,
    ctx(async () => {
      throw new Error("unexpected fetch");
    }),
    { validate: false },
  );
  assert.equal(result.ok, true);
  const oauth: CredentialState = {
    provider: "xai",
    authenticatedAt: null,
    credentials: {
      accessToken: "old",
      refreshToken: "refresh",
      tokenEndpoint: "https://auth.x.ai/token",
      expiresAt: Date.now() + 999_999,
    },
  };
  const refreshed = await xai.checkAuth(
    oauth,
    ctx(async () => Response.json({ access_token: "new", expires_in: 3600 })),
    { forceRefresh: true },
  );
  assert.equal(refreshed.ok, true);
  if (refreshed.ok) {
    assert.equal(refreshed.value.credentials.accessToken, "new");
  }
});
