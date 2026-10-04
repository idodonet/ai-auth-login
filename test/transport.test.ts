import assert from "node:assert/strict";
import test from "node:test";
import { countedFetch } from "../src/transport.js";

const stats = () => ({ startedAt: new Date().toISOString(), requestsSent: 0, requestsFailed: 0 });
test("counts HTTP, network and SSE errors once per attempt", async () => {
  const s = stats();
  const http = countedFetch(async () => new Response("failure", { status: 503 }), s);
  await (await http("https://upstream.invalid")).text();
  const network = countedFetch(async () => {
    throw new TypeError("network");
  }, s);
  await assert.rejects(network("https://upstream.invalid"));
  const stream = countedFetch(
    async () =>
      new Response('event: error\ndata: {"error":{"message":"failed"}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    s,
  );
  await (await stream("https://upstream.invalid")).text();
  assert.equal(s.requestsSent, 3);
  assert.equal(s.requestsFailed, 3);
});
test("stream read failure and caller cancellation count once", async () => {
  const s = stats();
  const fetch = countedFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("broken stream"));
          },
        }),
      ),
    s,
  );
  await assert.rejects((await fetch("https://upstream.invalid")).text());
  const cancelFetch = countedFetch(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        }),
      ),
    s,
  );
  const response = await cancelFetch("https://upstream.invalid");
  await response.body!.cancel();
  assert.equal(s.requestsFailed, 2);
});
test("successful stream and aborted stream ownership", async () => {
  const s = stats();
  const success = countedFetch(async () => new Response("ok"), s);
  assert.equal(await (await success("https://upstream.invalid")).text(), "ok");
  assert.equal(s.requestsFailed, 0);
  const controller = new AbortController();
  const hanging = countedFetch(async () => new Response(new ReadableStream()), s);
  const response = await hanging("https://upstream.invalid", { signal: controller.signal });
  controller.abort();
  await response.body!.cancel();
  assert.equal(s.requestsFailed, 1);
});
