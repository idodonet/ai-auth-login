import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createDemoServer } from "../src/server/server.js";
import type { Bootstrap, ChatEvent, Result, SessionView, TabAction } from "../src/shared/types.js";
// The same stdlib upstream is runnable by the browser acceptance operator.
// @ts-expect-error Test fixture is intentionally plain JavaScript.
import { createTestUpstream } from "../scripts/test-upstream.mjs";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("real SDK connects, streams, restores opaque state, and isolates demo tabs", async () => {
  const upstream: Server = createTestUpstream({ delay: 1 });
  const upstreamURL = await listen(upstream);
  const demo = createDemoServer();
  const origin = await listen(demo.server);
  try {
    const bootstrapResponse = await fetch(`${origin}/api/bootstrap`, {
      headers: { Origin: origin },
    });
    const bootstrap = (await bootstrapResponse.json()) as Result<Bootstrap>;
    assert.ok(bootstrap.ok);
    assert.equal(bootstrap.value.providers.length, 13);
    const headers = {
      Origin: origin,
      "X-Demo-Token": bootstrap.value.token,
      "Content-Type": "application/json",
    };
    const action = async (id: string, input: TabAction) => {
      const response = await fetch(`${origin}/api/tabs/${id}/action`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 200);
      const result = (await response.json()) as Result<SessionView>;
      assert.ok(result.ok, JSON.stringify(result));
      return result.value;
    };
    const chat = async (id: string, model = "demo-chat") => {
      const response = await fetch(`${origin}/api/tabs/${id}/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Hello" }],
        }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
      return (await response.text())
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ChatEvent);
    };
    const connected = await action("first", {
      type: "connect",
      provider: "openai-compatibility",
      credentials: {
        kind: "api-key",
        apiKey: "demo-key",
        baseURL: `${upstreamURL}/v1`,
      },
    });
    assert.deepEqual(connected.auth, { valid: true });
    assert.deepEqual(
      connected.models.map((model) => model.id),
      ["demo-chat", "demo-error"],
    );
    assert.equal(connected.stats.requestsSent, 0);
    assert.ok(connected.sdkState);

    const events = await chat("first");
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(
      events
        .filter((event) => event.type === "delta")
        .map((event) => event.text)
        .join(""),
      "Hello from the local demo upstream. Streaming works, and Stop can cancel this reply.",
    );
    const refreshed = await action("first", { type: "refresh" });
    assert.equal(refreshed.stats.requestsSent, 1);
    const same = await action("first", {
      type: "restore",
      state: connected.sdkState,
    });
    assert.equal(same.stats.startedAt, refreshed.stats.startedAt);
    assert.equal(same.stats.requestsSent, 1);

    const restored = await action("second", {
      type: "restore",
      state: connected.sdkState,
    });
    assert.deepEqual(restored.auth, { valid: true });
    assert.equal(restored.stats.requestsSent, 0);
    assert.equal((await chat("second", "demo-error"))[0]?.type, "error");
    const failed = await action("second", { type: "refresh" });
    assert.equal(failed.stats.requestsSent, 1);
    assert.equal(failed.stats.requestsFailed, 1);
    assert.equal((await action("first", { type: "refresh" })).stats.requestsFailed, 0);

    // Stop must reach the actual upstream socket, not merely hide browser text.
    let upstreamClosed!: Promise<unknown>;
    let stoppedBeforeDone = false;
    const observeStop = (
      request: import("node:http").IncomingMessage,
      response: import("node:http").ServerResponse,
    ) => {
      if (request.url !== "/v1/chat/completions") {
        return;
      }
      upstream.off("request", observeStop);
      upstreamClosed = once(response, "close", {
        signal: AbortSignal.timeout(2000),
      });
      response.once("close", () => {
        stoppedBeforeDone = !response.writableFinished;
      });
    };
    upstream.on("request", observeStop);
    const stop = new AbortController();
    const running = await fetch(`${origin}/api/tabs/first/chat`, {
      method: "POST",
      headers,
      signal: stop.signal,
      body: JSON.stringify({
        model: "demo-slow",
        messages: [{ role: "user", content: "Stop this reply" }],
      }),
    });
    const runningReader = running.body!.getReader();
    assert.match(new TextDecoder().decode((await runningReader.read()).value), /"type":"delta"/);
    stop.abort();
    await assert.rejects(runningReader.read(), { name: "AbortError" });
    await upstreamClosed;
    assert.equal(stoppedBeforeDone, true);
    assert.equal((await chat("first")).at(-1)?.type, "done");
    const afterStop = await action("first", { type: "refresh" });
    assert.deepEqual(afterStop.auth, { valid: true });
    assert.equal(afterStop.sdkState, connected.sdkState);
    assert.equal(afterStop.stats.requestsSent, 3);
    assert.equal(afterStop.stats.requestsFailed, 1);

    const feed = await fetch(`${origin}/api/events`, { headers });
    const reader = feed.body!.getReader();
    const snapshot = new TextDecoder().decode((await reader.read()).value);
    assert.match(snapshot, /"type":"session"/);
    assert.match(snapshot, /"tabId":"first"/);
    await reader.cancel();
    const loggedOut = await action("first", { type: "logout" });
    assert.equal(loggedOut.sdkState, null);
    assert.equal(loggedOut.auth.valid, false);
    assert.equal(loggedOut.models.length, 0);
    assert.equal((await action("second", { type: "refresh" })).auth.valid, true);
    await action("second", { type: "close" });
    assert.equal(
      demo.manager.snapshots().some((tab) => tab.id === "second"),
      false,
    );

    assert.equal(
      (
        await fetch(`${origin}/api/bootstrap`, {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/tabs/first/action`, {
          method: "POST",
          headers: { ...headers, "X-Demo-Token": "wrong" },
          body: '{"type":"refresh"}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/tabs/first/action`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            type: "restore",
            state: "x".repeat(1_048_576),
          }),
        })
      ).status,
      400,
    );
  } finally {
    await demo.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
