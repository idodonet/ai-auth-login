import assert from "node:assert/strict";
import test from "node:test";
import {
  chatToResponses,
  responsesToChat,
  executeChat,
  executeResponses,
  normalizeResponsesResponse,
} from "../src/protocols/responses.js";
import { parseSSE, encodeSSE } from "../src/protocols/sse.js";
import { xai } from "../src/providers/xai/index.js";
import { meta } from "../src/providers/meta/index.js";

const request = (body: unknown) =>
  new Request("https://internal/v1", { method: "POST", body: JSON.stringify(body) });
test("Responses prefix detection aborts a pending read and releases its reader", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const result = normalizeResponsesResponse(new Response(body), controller.signal);
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
function sse(values: unknown[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const value of values) {
          controller.enqueue(encodeSSE(undefined, value));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
test("xAI and Meta collect mislabeled Responses SSE in both nonstream endpoints", async () => {
  const value = {
    id: "r",
    object: "response",
    model: "m",
    created_at: 0,
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "1" }] }],
  };
  for (const adapter of [xai, meta]) {
    for (const path of ["/responses", "/chat/completions"]) {
      for (const contentType of [
        undefined,
        "application/json",
        "text/plain",
        "text/event-stream",
      ]) {
        for (const wire of ["json", "sse"]) {
          if (wire === "json" && contentType === "text/event-stream") continue;
          let cancelled = false;
          const raw = new TextEncoder().encode(
            wire === "json"
              ? JSON.stringify(value)
              : `: heartbeat\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: value })}\n\n`,
          );
          const response = await adapter.execute(
            new Request(`https://internal/v1${path}`, {
              method: "POST",
              body: JSON.stringify(
                path === "/responses"
                  ? { model: "m", input: "Say 1" }
                  : { model: "m", messages: [{ role: "user", content: "Say 1" }] },
              ),
            }),
            {
              provider: adapter.descriptor.id,
              authenticatedAt: null,
              credentials: { apiKey: "fixture" },
            },
            {
              signal: new AbortController().signal,
              fetch: async () =>
                new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      // A fragmented prefix must not cause JSON parsing or wait for SSE EOF.
                      for (const byte of raw) controller.enqueue(Uint8Array.of(byte));
                      if (wire === "json") controller.close();
                    },
                    cancel() {
                      cancelled = true;
                    },
                  }),
                  {
                    headers: {
                      ...(contentType ? { "content-type": contentType } : {}),
                      "x-request-id": "r",
                    },
                  },
                ),
            },
          );
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("x-request-id"), "r");
          const result = await response.json();
          assert.equal(
            path === "/responses"
              ? result.output[0].content[0].text
              : result.choices[0].message.content,
            "1",
          );
          if (wire === "sse") assert.equal(cancelled, true);
        }
      }
    }
  }
});
test("SSE decodes fragmented UTF8, CRLF, multiline data and cancels", async () => {
  const bytes = new TextEncoder().encode("event: hello\r\ndata: hé\r\ndata: there\r\n\r\n");
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) {
        controller.enqueue(Uint8Array.of(byte));
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const events = parseSSE(stream);
  assert.deepEqual((await events.next()).value, { event: "hello", data: "hé\nthere" });
  await events.return(undefined);
  assert.equal(cancelled, true);
});
test("request translation preserves images, function calls/results and structured output", () => {
  const body = {
    model: "test",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,YQ==", detail: "low" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "found" },
    ],
    tools: [
      {
        type: "function",
        function: { name: "lookup", parameters: { type: "object" }, strict: true },
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "result", schema: { type: "object" }, strict: true },
    },
  };
  const translated = chatToResponses(body);
  assert.equal(translated.input[0].content[0].image_url, "data:image/png;base64,YQ==");
  assert.equal(translated.input[1].call_id, "c1");
  const roundtrip = responsesToChat(translated);
  assert.deepEqual(roundtrip.messages, body.messages);
  assert.deepEqual(roundtrip.tools, body.tools);
  assert.deepEqual(roundtrip.response_format, body.response_format);
  assert.throws(() => chatToResponses({ model: "test", messages: [], audio: {} }), /Unsupported/);
});
test("Responses stream emits SDK sequence and tool arguments without buffering", async () => {
  const response = await executeResponses(
    request({ model: "m", input: "hi", stream: true }),
    async (body) => {
      assert.equal(body.messages[0].content, "hi");
      return sse([
        { id: "c", model: "m", choices: [{ index: 0, delta: { content: "hello" } }] },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: "t", function: { name: "fn", arguments: "{" } }],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
        "[DONE]",
      ]);
    },
  );
  const events = [];
  for await (const event of parseSSE(response.body!)) {
    events.push(JSON.parse(event.data));
  }
  assert.equal(events[0].type, "response.created");
  assert.deepEqual(
    events.map((e) => e.sequence_number),
    events.map((_, i) => i),
  );
  const final = events.at(-1).response;
  assert.equal(final.output[0].content[0].text, "hello");
  assert.equal(final.output[1].arguments, "{}");
  assert.equal(final.usage.total_tokens, 7);
});
test("truncated streams fail instead of reporting success", async () => {
  const response = await executeResponses(
    request({ model: "m", input: "hi", stream: true }),
    async () => sse([{ choices: [{ index: 0, delta: { content: "partial" } }] }]),
  );
  await assert.rejects(() => response.text(), /ended before completion/);
});
test("Chat bridge preserves upstream errors, request ID and nonstream Codex completion", async () => {
  const failure = Response.json(
    { error: { message: "limited" } },
    { status: 429, headers: { "retry-after": "2" } },
  );
  assert.equal(
    await executeChat(request({ model: "m", messages: [] }), async () => failure),
    failure,
  );
  const response = await executeChat(request({ model: "m", messages: [] }), async () => {
    const response = sse([
      {
        type: "response.completed",
        response: {
          id: "r",
          model: "m",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "yes" }] }],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        },
      },
    ]);
    response.headers.set("x-request-id", "request-1");
    return response;
  });
  assert.equal(response.headers.get("x-request-id"), "request-1");
  assert.equal((await response.json()).choices[0].message.content, "yes");
});
test("malformed client JSON is 400", async () => {
  const response = await executeChat(
    new Request("https://internal", { method: "POST", body: "{" }),
    async () => {
      throw new Error("must not send");
    },
  );
  assert.equal(response.status, 400);
});
test("cancelling translated stream aborts native fetch and releases reader", async () => {
  let nativeSignal: AbortSignal | undefined,
    cancelled = false;
  const response = await executeResponses(
    request({ model: "m", input: "hi", stream: true }),
    async (_body, signal) => {
      nativeSignal = signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encodeSSE(undefined, {
                id: "c",
                choices: [{ index: 0, delta: { content: "hello" } }],
              }),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(nativeSignal!.aborted, true);
  assert.equal(cancelled, true);
});
test("Responses thinking summary survives both JSON conversion directions", async () => {
  const response = await executeResponses(
    request({ model: "m", input: "hi", reasoning: { summary: "auto" } }),
    async () =>
      Response.json({
        id: "c",
        model: "m",
        choices: [
          { message: { content: "answer", reasoning_content: "thinking" }, finish_reason: "stop" },
        ],
      }),
  );
  const body = await response.json();
  assert.equal(body.output[0].type, "reasoning");
  assert.equal(body.output[0].summary[0].text, "thinking");
  const chat = await executeChat(request({ model: "m", messages: [] }), async () =>
    Response.json(body),
  );
  assert.equal((await chat.json()).choices[0].message.reasoning_content, "thinking");
  assert.throws(
    () => responsesToChat({ input: [], reasoning: { summary: "detailed" } }),
    /summary=auto/,
  );
  assert.deepEqual(
    responsesToChat({
      input: [{ type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] }],
    }).messages,
    [],
  );
});
test("real OpenAI SDK consumes default thinking responses through Gemini and Anthropic", async () => {
  const { default: OpenAI } = await import("openai");
  const { executeGemini } = await import("../src/protocols/gemini.js");
  const { executeAnthropic } = await import("../src/protocols/anthropic.js");
  for (const provider of ["gemini", "anthropic"]) {
    const execute = provider === "gemini" ? executeGemini : executeAnthropic;
    const sdk = new OpenAI({
      apiKey: "internal",
      baseURL: "https://internal/v1",
      maxRetries: 0,
      fetch: async (input, init) =>
        execute(new Request(input, init), async (body) => {
          if (!body.stream) {
            return provider === "gemini"
              ? Response.json({
                  candidates: [
                    {
                      content: { parts: [{ thought: true, text: "thinking" }, { text: "answer" }] },
                      finishReason: "STOP",
                    },
                  ],
                })
              : Response.json({
                  id: "m",
                  content: [
                    { type: "thinking", thinking: "thinking" },
                    { type: "text", text: "answer" },
                  ],
                  stop_reason: "end_turn",
                  usage: {},
                });
          }
          return provider === "gemini"
            ? sse([
                { candidates: [{ content: { parts: [{ thought: true, text: "thinking" }] } }] },
                {
                  candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
                },
              ])
            : sse([
                { type: "message_start", message: { id: "m", model: "m", usage: {} } },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "thinking_delta", thinking: "thinking" },
                },
                {
                  type: "content_block_delta",
                  index: 1,
                  delta: { type: "text_delta", text: "answer" },
                },
                { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
              ]);
        }),
    });
    const value = await sdk.responses.create({ model: "m", input: "hello" });
    const reasoning = value.output.find((item) => item.type === "reasoning");
    assert.equal(reasoning?.summary[0].text, "thinking", provider);
    const stream = await sdk.responses.create({ model: "m", input: "hello", stream: true });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    assert.equal(
      events.find((event) => event.type === "response.reasoning_summary_text.delta")?.delta,
      "thinking",
      provider,
    );
    const completed = events.find((event) => event.type === "response.completed");
    assert.equal(
      completed?.response.output.find((item) => item.type === "reasoning")?.summary[0].text,
      "thinking",
      provider,
    );
  }
});
test("Responses multimedia inputs preserve files, URLs, audio and video without guessing file IDs", () => {
  const parts = [
    { type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,YQ==" },
    { type: "input_file", file_url: "https://example.com/a.pdf" },
    { type: "input_audio", input_audio: { format: "wav", data: "YQ==" } },
    { type: "input_video", video_url: "data:video/mp4;base64,YQ==" },
  ];
  const chat = responsesToChat({ input: [{ role: "user", content: parts }] });
  assert.deepEqual(
    chat.messages[0].content.map((part: any) => part.type),
    ["file", "file", "input_audio", "video_url"],
  );
  assert.deepEqual(chatToResponses(chat).input[0].content, parts);
  assert.throws(
    () =>
      responsesToChat({
        input: [{ role: "user", content: [{ type: "input_file", file_id: "file-1" }] }],
      }),
    /file_id is unsupported/,
  );
});
test("SDK Responses preserves generated Gemini images in JSON and streams", async () => {
  const { default: OpenAI } = await import("openai");
  const { executeGemini } = await import("../src/protocols/gemini.js");
  const image = "iVBORw0KGgo=";
  const sdk = new OpenAI({
    apiKey: "internal",
    baseURL: "https://internal/v1",
    maxRetries: 0,
    fetch: async (input, init) =>
      executeGemini(new Request(input, init), async (body) => {
        const native = {
          candidates: [
            {
              content: { parts: [{ inlineData: { mimeType: "image/png", data: image } }] },
              finishReason: "STOP",
            },
          ],
        };
        return body.stream ? sse([native]) : Response.json(native);
      }),
  });
  const value = await sdk.responses.create({ model: "m", input: "draw a cat" });
  const output = value.output.find((item) => item.type === "image_generation_call");
  assert.equal(output?.result, image);
  const stream = await sdk.responses.create({ model: "m", input: "draw a cat", stream: true });
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(
    completed?.response.output.find((item) => item.type === "image_generation_call")?.result,
    image,
  );
});
