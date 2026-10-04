import test from "node:test";
import assert from "node:assert/strict";
import { codex } from "../../src/providers/codex/index.js";
import type { CredentialState, ProviderContext } from "../../src/providers/contract.js";
const state: CredentialState = {
  provider: "codex",
  authenticatedAt: null,
  credentials: { access_token: "secret" },
};
function context(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ProviderContext {
  return {
    signal: new AbortController().signal,
    fetch: (async (url, init) => handler(String(url), init)) as typeof fetch,
  };
}
function request(body: Record<string, unknown>): Request {
  return new Request("https://internal/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const terminal = (output: unknown[], extra = {}) =>
  `data: ${JSON.stringify({ type: "response.completed", response: { created_at: 100, output, ...extra } })}\n\n`;
const image = {
  type: "image_generation_call",
  result: "aGVsbG8=",
  output_format: "webp",
  revised_prompt: "revised",
  quality: "high",
};
test("Codex modern image models use native generations and preserve upstream errors and streams", async () => {
  for (const model of [
    "gpt-image-1.5",
    "gpt-image-2",
    "gpt-image-2.5",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
  ]) {
    const result = await codex.execute(
      request({ model, prompt: "draw", stream: true }),
      state,
      context((url, init) => {
        assert.equal(url, "https://chatgpt.com/backend-api/codex/images/generations");
        assert.equal(JSON.parse(String(init?.body)).stream, true);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
        return new Response('data: {"type":"image_generation.completed"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    assert.match(await result.text(), /image_generation.completed/);
  }
  const failure = await codex.execute(
    request({ prompt: "draw" }),
    state,
    context(() => Response.json({ error: { message: "denied" } }, { status: 403 })),
  );
  assert.equal(failure.status, 403);
});
test("Codex older image model translates tools and b64/url output including usage metadata", async () => {
  for (const response_format of ["url", "b64_json"]) {
    const result = await codex.execute(
      request({ model: "gpt-image-1", prompt: "draw", response_format, size: "1024x1024" }),
      state,
      context((url, init) => {
        assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
        const sent = JSON.parse(String(init?.body));
        assert.equal(sent.model, "gpt-5.4-mini");
        assert.equal(sent.tools[0].action, "generate");
        assert.equal(sent.tools[0].model, "gpt-image-1");
        assert.equal(sent.tools[0].size, "1024x1024");
        return new Response(terminal([image], { tool_usage: { image_gen: { total_tokens: 9 } } }), {
          headers: { "content-type": "text/event-stream", "x-request-id": "r" },
        });
      }),
    );
    const data = await result.json();
    assert.equal(data.created, 100);
    assert.equal(data.usage.total_tokens, 9);
    assert.equal(data.data[0].revised_prompt, "revised");
    assert.equal(data.quality, "high");
    assert.equal(result.headers.get("x-request-id"), "r");
    assert.equal(
      data.data[0][response_format],
      response_format === "url" ? "data:image/webp;base64,aGVsbG8=" : "aGVsbG8=",
    );
  }
});
test("Codex multipart edits convert images and mask to JSON for direct and tool routes", async () => {
  for (const model of ["gpt-image-2", "gpt-image-1"]) {
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", "edit");
    form.append("image[]", new Blob(["image"], { type: "image/png" }), "image.png");
    form.set("mask", new Blob(["mask"], { type: "image/png" }), "mask.png");
    form.set("output_compression", "80");
    const input = new Request("https://internal/v1/images/edits", { method: "POST", body: form });
    const result = await codex.execute(
      input,
      state,
      context((url, init) => {
        const sent = JSON.parse(String(init?.body));
        assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
        if (model === "gpt-image-2") {
          assert.ok(url.endsWith("/images/edits"));
          assert.match(sent.images[0].image_url, /^data:image\/png;base64,/);
          assert.match(sent.mask.image_url, /^data:image\/png;base64,/);
          assert.equal(sent.output_compression, 80);
          return Response.json({ data: [{ b64_json: "a" }] });
        }
        assert.ok(url.endsWith("/responses"));
        assert.equal(sent.tools[0].action, "edit");
        assert.match(sent.tools[0].input_image_mask.image_url, /^data:image\/png;base64,/);
        assert.equal(sent.input[0].content[1].type, "input_image");
        return new Response(terminal([image]), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    assert.equal(result.status, 200);
  }
});
test("Codex tool image streams translate partial events and recover ordered output_item fallback", async () => {
  const events =
    `data: ${JSON.stringify({ type: "response.image_generation_call.partial_image", partial_image_b64: "cGFydA==", partial_image_index: 1, output_format: "jpeg" })}\n\n` +
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 2, item: image })}\n\n` +
    terminal([]);
  const result = await codex.execute(
    request({
      model: "gpt-image-1",
      prompt: "draw",
      stream: true,
      partial_images: 1,
      response_format: "url",
    }),
    state,
    context(() => new Response(events, { headers: { "content-type": "text/event-stream" } })),
  );
  const text = await result.text();
  assert.match(text, /event: image_generation.partial_image/);
  assert.match(text, /data:image\/jpeg;base64,cGFydA==/);
  assert.match(text, /event: image_generation.completed/);
  assert.match(text, /data:image\/webp;base64,aGVsbG8=/);
});
test("Codex image validation rejects unsupported options and malformed/truncated outputs", async () => {
  for (const body of [
    { prompt: "draw", surprise: true },
    { prompt: "draw", model: "gpt-image-1", n: 2 },
    { prompt: "draw", partial_images: 4 },
    { prompt: "" },
  ]) {
    const result = await codex.execute(
      request(body),
      state,
      context(() => {
        throw Error("must not fetch");
      }),
    );
    assert.equal(result.status, 400);
  }
  const result = await codex.execute(
    request({ model: "gpt-image-1", prompt: "draw" }),
    state,
    context(
      () =>
        new Response('data: {"type":"response.created"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    ),
  );
  assert.equal(result.status, 502);
});
test("Codex image streaming cancellation aborts the owned upstream reader", async () => {
  let cancelled = false;
  const result = await codex.execute(
    request({ model: "gpt-image-1", prompt: "draw", stream: true }),
    state,
    context(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
  );
  const reader = result.body!.getReader();
  const pending = reader.read();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await reader.cancel();
  await pending;
  assert.equal(cancelled, true);
});
test("Codex request image input has a bounded body before parsing and no network on over-limit", async () => {
  const input = new Request("https://internal/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(33 * 1024 * 1024) },
    body: "{}",
  });
  const result = await codex.execute(
    input,
    state,
    context(() => {
      throw Error("network forbidden");
    }),
  );
  assert.equal(result.status, 400);
  assert.match((await result.json()).error.message, /32 MiB/);
});
