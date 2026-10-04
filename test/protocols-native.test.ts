import { test } from "node:test";
import OpenAI from "openai";
import assert from "node:assert/strict";
import { executeAnthropic } from "../src/protocols/anthropic.js";
import { executeGemini, executeInteractions } from "../src/protocols/gemini.js";
import { parseSSE } from "../src/protocols/sse.js";
const request = (body: unknown, path = "chat/completions", signal?: AbortSignal) =>
  new Request(`https://internal/v1/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
function splitStream(events: unknown[]) {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3) {
          c.enqueue(bytes.slice(i, i + 3));
        }
        c.close();
      },
    }),
  );
}
test("Anthropic tools, tool results, image and schema survive translation", async () => {
  const response = await executeAnthropic(
    request({
      model: "claude",
      messages: [
        { role: "system", content: "Be helpful" },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "a",
              type: "function",
              function: { name: "weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "sunny" },
      ],
      response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } },
    }),
    async (body) => {
      assert.equal((body.messages as any[])[0].content[0].source.data, "YQ==");
      assert.equal((body.messages as any[])[1].content[0].input.city, "Paris");
      assert.equal((body.messages as any[])[2].content[0].tool_use_id, "a");
      assert.deepEqual((body.output_config as any).format.schema, { type: "object" });
      return Response.json({
        id: "m",
        content: [{ type: "tool_use", id: "b", name: "weather", input: { city: "Rome" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    },
  );
  const value = await response.json();
  assert.equal(value.choices[0].finish_reason, "tool_calls");
  assert.equal(value.usage.total_tokens, 7);
});
test("Anthropic split-byte stream preserves tool argument deltas and reasoning", async () => {
  const response = await executeAnthropic(
    request({
      model: "claude",
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    }),
    async () =>
      splitStream([
        {
          type: "message_start",
          message: { id: "m", model: "claude", usage: { input_tokens: 4 } },
        },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "call1", name: "lookup", input: {} },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"x":' },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: "1}" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "réfléchir" },
        },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      ]),
  );
  const events = [];
  for await (const e of parseSSE(response.body!)) {
    if (e.data !== "[DONE]") {
      events.push(JSON.parse(e.data));
    }
  }
  assert.equal(events[1].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(events[2].choices[0].delta.tool_calls[0].function.arguments, '{"x":');
  assert.equal(events[4].choices[0].delta.reasoning_content, "réfléchir");
  assert.equal(events.at(-1).usage.total_tokens, 7);
});
test("Gemini model, tools, image and thought metadata translated", async () => {
  const response = await executeGemini(
    request({
      model: "gemini",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,YQ==" } }],
        },
        {
          role: "assistant",
          tool_calls: [{ id: "a", function: { name: "lookup", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "a", content: "42" },
      ],
      response_format: { type: "json_object" },
    }),
    async (body) => {
      assert.equal(body.model, "gemini");
      assert.equal((body.contents as any[])[0].parts[0].inlineData.data, "YQ==");
      assert.equal((body.contents as any[])[2].parts[0].functionResponse.name, "lookup");
      assert.equal((body.generationConfig as any).responseMimeType, "application/json");
      return Response.json({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: "reason" },
                  { text: "answer" },
                  { functionCall: { name: "lookup", args: { x: 1 } }, thoughtSignature: "sig" },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 2,
            candidatesTokenCount: 3,
            thoughtsTokenCount: 1,
            totalTokenCount: 6,
          },
        },
      });
    },
  );
  const value = await response.json();
  assert.equal(value.choices[0].message.reasoning_content, "reason");
  assert.equal(value.choices[0].message.tool_calls[0].thought_signature, "sig");
  assert.equal(value.usage.completion_tokens, 4);
});
test("Gemini streams wrapped candidate tool calls with terminal reason", async () => {
  const response = await executeGemini(
    request({ model: "g", messages: [], stream: true }),
    async () =>
      splitStream([
        {
          response: {
            candidates: [
              { index: 0, content: { parts: [{ functionCall: { name: "f", args: { x: 1 } } }] } },
            ],
          },
        },
        { response: { candidates: [{ index: 0, finishReason: "STOP" }] } },
      ]),
  );
  const events = [];
  for await (const e of parseSSE(response.body!)) {
    if (e.data !== "[DONE]") {
      events.push(JSON.parse(e.data));
    }
  }
  assert.equal(events[0].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(events[1].choices[0].finish_reason, "tool_calls");
});
test("Interactions uses native input steps and translates streaming arguments", async () => {
  const response = await executeInteractions(
    request({ model: "g", messages: [{ role: "user", content: "hello" }], stream: true }),
    async (body) => {
      assert.equal((body.input as any[])[0].type, "user_input");
      return splitStream([
        {
          event_type: "step.start",
          index: 1,
          step: { type: "function_call", call_id: "a", name: "f" },
        },
        { event_type: "step.delta", index: 1, delta: { type: "arguments_delta", arguments: "{}" } },
        { event_type: "interaction.completed" },
      ]);
    },
  );
  const events = [];
  for await (const e of parseSSE(response.body!)) {
    if (e.data !== "[DONE]") {
      events.push(JSON.parse(e.data));
    }
  }
  assert.equal(events[1].choices[0].delta.tool_calls[0].function.arguments, "{}");
  assert.equal(events[2].choices[0].finish_reason, "tool_calls");
});
test("unsupported options fail explicitly without upstream call; upstream errors retain status", async () => {
  let called = false;
  const bad = await executeAnthropic(
    request({ model: "c", messages: [], logprobs: true }),
    async () => {
      called = true;
      return Response.json({});
    },
  );
  assert.equal(bad.status, 400);
  assert.equal(called, false);
  const upstream = new Response("quota", { status: 429 });
  assert.equal(
    await executeGemini(request({ model: "g", messages: [] }), async () => upstream),
    upstream,
  );
});
test("native transport receives caller abort signal", async () => {
  const controller = new AbortController();
  controller.abort();
  let observed = false;
  await assert.rejects(
    executeGemini(
      request({ model: "g", messages: [] }, "chat/completions", controller.signal),
      async (_body, signal) => {
        observed = signal.aborted;
        signal.throwIfAborted();
        return Response.json({});
      },
    ),
  );
  assert.equal(observed, true);
});
test("Responses input uses shared conversion through native providers", async () => {
  const response = await executeGemini(
    request({ model: "g", input: "hello" }, "responses"),
    async (body) => {
      assert.equal((body.contents as any[])[0].parts[0].text, "hello");
      return Response.json({
        candidates: [{ content: { parts: [{ text: "world" }] }, finishReason: "STOP" }],
      });
    },
  );
  const value = await response.json();
  assert.equal(value.object, "response");
  assert.equal(value.output[0].content[0].text, "world");
});
test("cancelling output aborts a pending native stream read", async () => {
  let cancelled = false;
  let upstreamSignal: AbortSignal | undefined;
  const response = await executeGemini(
    request({ model: "g", messages: [], stream: true }),
    async (_body, signal) => {
      upstreamSignal = signal;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  );
  const reader = response.body!.getReader();
  const pending = reader.read();
  await reader.cancel();
  await pending;
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(cancelled, true);
});
test("signed native Chat reasoning is retained and can be replayed", async () => {
  const previous = {
    role: "assistant",
    content: "answer",
    reasoning_content: "thought",
    reasoning_signature: "signature",
  };
  for (const execute of [executeAnthropic, executeGemini]) {
    const result = await execute(
      request({ model: "native", messages: [previous, { role: "user", content: "next" }] }),
      async (body) => {
        if (body.contents) {
          assert.deepEqual((body.contents as any[])[0].parts[0], {
            thought: true,
            text: "thought",
            thoughtSignature: "signature",
          });
        } else {
          assert.deepEqual((body.messages as any[])[0].content[0], {
            type: "thinking",
            thinking: "thought",
            signature: "signature",
          });
        }
        return body.contents
          ? Response.json({
              candidates: [
                {
                  content: {
                    parts: [
                      { thought: true, text: "next thought", thoughtSignature: "next signature" },
                      { text: "answer" },
                    ],
                  },
                },
              ],
            })
          : Response.json({
              id: "a",
              content: [
                { type: "thinking", thinking: "next thought", signature: "next signature" },
                { type: "text", text: "answer" },
              ],
              stop_reason: "end_turn",
            });
      },
    );
    const message = (await result.json()).choices[0].message;
    assert.equal(message.reasoning_signature, "next signature");
    assert.equal(message.reasoning_blocks.length, 1);
  }
});

for (const protocol of ["anthropic", "gemini"] as const) {
  test(`OpenAI SDK Responses consumes ${protocol} native thinking and text stream`, async () => {
    const execute = protocol === "anthropic" ? executeAnthropic : executeGemini;
    const sdk = new OpenAI({
      apiKey: "internal",
      baseURL: "https://internal/v1",
      fetch: async (url, init) =>
        execute(new Request(url, init), async () =>
          protocol === "anthropic"
            ? splitStream([
                {
                  type: "message_start",
                  message: { id: "message", model: "claude", usage: { input_tokens: 2 } },
                },
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "thinking", thinking: "", signature: "" },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "thinking_delta", thinking: "think" },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "signature_delta", signature: "sig" },
                },
                { type: "content_block_stop", index: 0 },
                {
                  type: "content_block_delta",
                  index: 1,
                  delta: { type: "text_delta", text: "answer" },
                },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  usage: { output_tokens: 3 },
                },
              ])
            : splitStream([
                {
                  candidates: [
                    {
                      index: 0,
                      content: {
                        parts: [{ thought: true, text: "think", thoughtSignature: "sig" }],
                      },
                    },
                  ],
                },
                {
                  candidates: [
                    { index: 0, content: { parts: [{ text: "answer" }] }, finishReason: "STOP" },
                  ],
                  usageMetadata: {
                    promptTokenCount: 2,
                    candidatesTokenCount: 3,
                    totalTokenCount: 5,
                  },
                },
              ]),
        ),
    });
    const stream = await sdk.responses.create({ model: "native", input: "question", stream: true });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    assert.equal(
      events
        .filter((e) => e.type === "response.reasoning_summary_text.delta")
        .map((e) => (e as any).delta)
        .join(""),
      "think",
    );
    assert.equal(
      events
        .filter((e) => e.type === "response.output_text.delta")
        .map((e) => (e as any).delta)
        .join(""),
      "answer",
    );
    const final = events.find((e) => e.type === "response.completed") as any;
    assert.ok(final);
    assert.equal(
      final.response.output.find((item: any) => item.type === "reasoning").summary[0].text,
      "think",
    );
  });
}
test("Gemini audio, video and documents preserve inline MIME payloads", async () => {
  await executeGemini(
    request({
      model: "g",
      messages: [
        {
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: "YQ==", format: "mp3" } },
            { type: "file", file: { filename: "report.pdf", file_data: "Yg==" } },
            { type: "video_url", video_url: { url: "data:video/mp4;base64,Yw==" } },
          ],
        },
      ],
    }),
    async (body) => {
      assert.deepEqual(
        (body.contents as any[])[0].parts.map((p: any) => p.inlineData),
        [
          { mimeType: "audio/mpeg", data: "YQ==" },
          { mimeType: "application/pdf", data: "Yg==" },
          { mimeType: "video/mp4", data: "Yw==" },
        ],
      );
      return Response.json({ candidates: [] });
    },
  );
  await executeAnthropic(
    request({
      model: "c",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              file: { filename: "report.pdf", file_data: "data:application/pdf;base64,YQ==" },
            },
          ],
        },
      ],
    }),
    async (body) => {
      assert.equal((body.messages as any[])[0].content[0].source.media_type, "application/pdf");
      return Response.json({ content: [], stop_reason: "end_turn" });
    },
  );
});
test("source-supported structured output options map without losing tool constraints", async () => {
  await executeGemini(
    request({
      model: "g",
      messages: [],
      tools: [
        {
          type: "function",
          function: { name: "lookup", strict: true, parameters: { type: "object" } },
        },
      ],
      tool_choice: "auto",
    }),
    async (body) => {
      assert.equal((body.toolConfig as any).functionCallingConfig.mode, "VALIDATED");
      assert.equal((body.tools as any[])[0].functionDeclarations[0].strict, undefined);
      return Response.json({ candidates: [] });
    },
  );
  await executeAnthropic(
    request({
      model: "a",
      messages: [
        { role: "system", content: "original" },
        { role: "user", content: "hello" },
      ],
      response_format: { type: "json_object" },
    }),
    async (body) => {
      assert.equal((body.system as any[])[0].text, "original");
      assert.match((body.system as any[])[1].text, /valid JSON object/);
      return Response.json({ content: [], stop_reason: "end_turn" });
    },
  );
});
test("Gemini accepts source-supported unsigned thought replay, Anthropic rejects it", async () => {
  const body = {
    model: "native",
    messages: [
      { role: "assistant", content: "answer", reasoning_content: "previous thought" },
      { role: "user", content: "continue" },
    ],
  };
  await executeGemini(request(body), async (wire) => {
    assert.deepEqual((wire.contents as any[])[0].parts[0], {
      thought: true,
      text: "previous thought",
    });
    return Response.json({ candidates: [] });
  });
  const result = await executeAnthropic(request(body), async () => {
    throw new Error("Must not call native");
  });
  assert.equal(result.status, 400);
});
test("Gemini remote document URLs and raw Anthropic PDFs preserve transport", async () => {
  await executeGemini(
    request({
      model: "g",
      messages: [
        {
          role: "user",
          content: [{ type: "file", file: { file_url: "https://example.org/report.pdf" } }],
        },
      ],
    }),
    async (body) => {
      assert.deepEqual((body.contents as any[])[0].parts[0], {
        fileData: { mimeType: "application/pdf", fileUri: "https://example.org/report.pdf" },
      });
      return Response.json({ candidates: [] });
    },
  );
  await executeAnthropic(
    request({
      model: "a",
      messages: [
        {
          role: "user",
          content: [{ type: "file", file: { filename: "report.pdf", file_data: "YQ==" } }],
        },
      ],
    }),
    async (body) => {
      assert.equal((body.messages as any[])[0].content[0].source.media_type, "application/pdf");
      return Response.json({ content: [], stop_reason: "end_turn" });
    },
  );
});
test("thinking options use legacy budgets and modern adaptive levels", async () => {
  for (const model of ["claude-sonnet-4-5", "claude-sonnet-4-6"]) {
    await executeAnthropic(
      request({
        model,
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "medium",
      }),
      async (body) => {
        assert.deepEqual(
          body.thinking,
          model.endsWith("4-6") ? { type: "adaptive" } : { type: "enabled", budget_tokens: 8192 },
        );
        return Response.json({ content: [], stop_reason: "end_turn" });
      },
    );
  }
  await executeGemini(
    request({ model: "gemini-2.5-pro", messages: [], reasoning_effort: "medium" }),
    async (body) => {
      assert.equal((body.generationConfig as any).thinkingConfig.thinkingBudget, 8192);
      return Response.json({ candidates: [] });
    },
  );
});
