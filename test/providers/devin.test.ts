import assert from "node:assert/strict";
import test from "node:test";
import { devin, parseUserStatus, decodeProto } from "../../src/providers/devin/index.js";
import { chatCompletionToResponse } from "../../src/protocols/responses.js";
import { ProviderSession } from "../../src/session.js";
import { encodeState } from "../../src/state.js";
import type { ProviderContext, CredentialState } from "../../src/providers/contract.js";
const state: CredentialState = {
  provider: "devin",
  authenticatedAt: "2026-01-01T00:00:00Z",
  credentials: { sessionToken: "devin-session-token$secret" },
};
const b = (n: number, value: Uint8Array | string) => {
  const raw = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Uint8Array.from([n * 8 + 2, raw.length, ...raw]);
};
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

test("Devin expiry aborts an active exchange and rejects late credentials", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let exchangeSignal: AbortSignal | undefined;
  let resolve!: (response: Response) => void;
  const result = await devin.beginAuth({
    signal: new AbortController().signal,
    fetch: async (_url, init) => {
      exchangeSignal = init?.signal as AbortSignal;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    },
  });
  assert.ok(result.ok && result.value.kind === "callback");
  const pending = result.value.complete("authorization-code");
  t.mock.timers.tick(600_000);
  assert.equal(exchangeSignal?.aborted, true);
  resolve(Response.json({ token: "late-token" }));
  const expired = await pending;
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.error.code, "auth-expired");
});
const account = b(
  1,
  join(
    b(7, "test@example.com"),
    b(36, "user"),
    b(
      13,
      join(
        b(1, b(2, "Pro")),
        Uint8Array.from([
          112, 30, 120, 80, 136, 1, 128, 226, 207, 170, 6, 144, 1, 128, 226, 207, 170, 6,
        ]),
      ),
    ),
  ),
);
test("Devin strict quota decoder preserves daily/weekly percentages and reset timestamps", () => {
  const result = parseUserStatus(account);
  assert.equal(result.email, "test@example.com");
  assert.equal(result.plan, "Pro");
  assert.equal(result.daily, 30);
  assert.equal(result.weekly, 80);
  assert.ok(result.dailyReset?.endsWith("Z"));
  assert.throws(() => decodeProto(Uint8Array.from([10, 100, 1])));
  assert.throws(() => decodeProto(Uint8Array.from([0])));
  assert.throws(() => parseUserStatus(Uint8Array.from([10, 2, 106, 10])));
  const absent = parseUserStatus(b(1, b(7, "a")));
  assert.equal(absent.daily, null);
  assert.equal(absent.weekly, null);
});

test("Devin explicitly validates once and skips status during SDK requests", async () => {
  let statuses = 0;
  const session = new ProviderSession({
    state: encodeState(state),
    fetch: async (url) => {
      if (String(url).endsWith("GetUserStatus")) {
        statuses++;
        return new Response(Buffer.from(account));
      }
      const payload = b(3, "hello");
      const trailer = new TextEncoder().encode("{}");
      return new Response(
        Buffer.from(
          join(
            Uint8Array.from([0, 0, 0, 0, payload.length]),
            payload,
            Uint8Array.from([2, 0, 0, 0, trailer.length]),
            trailer,
          ),
        ),
      );
    },
  });
  try {
    assert.deepEqual(await session.checkAuth(), { ok: true, value: { valid: true } });
    assert.equal(statuses, 1);
    const sdk = await session.createSDK();
    assert.ok(sdk.ok);
    assert.equal(statuses, 2);
    const chat = await sdk.value.chat.completions.create({
      model: "swe-2",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(chat.choices[0]?.message.content, "hello");
    assert.equal(statuses, 2);
  } finally {
    await session.close();
  }
});
test("Devin headless PKCE validates callback state and exchanges real code", async () => {
  let exchange: any;
  const context: ProviderContext = {
    signal: new AbortController().signal,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://api.devin.ai/auth/cli/token");
      exchange = JSON.parse(init!.body as string);
      return Response.json({ token: "jwt" });
    },
  };
  const result = await devin.beginAuth(context);
  assert.ok(result.ok);
  if (!result.ok || result.value.kind !== "callback") {
    return;
  }
  const url = new URL(result.value.url);
  assert.equal(url.searchParams.get("cli_pkce_marker"), "1");
  assert.equal(url.searchParams.has("redirect_uri"), false);
  const bad = await result.value.complete("http://127.0.0.1/callback?code=a&state=wrong");
  assert.equal(bad.ok, false);
  const complete = await result.value.complete(
    `http://127.0.0.1/callback?code=real&state=${url.searchParams.get("state")}`,
  );
  assert.ok(complete.ok);
  assert.equal(exchange.code, "real");
  assert.ok(exchange.code_verifier.length >= 43);
  if (complete.ok) {
    assert.equal(complete.value.credentials.sessionToken, "devin-session-token$jwt");
  }
  const repeated = await result.value.complete("real");
  assert.equal(repeated.ok, false);
});
test("Devin sends protobuf status and framed native chat rather than OpenAI upstream", async () => {
  const calls: string[] = [];
  const context: ProviderContext = {
    signal: new AbortController().signal,
    fetch: async (url, init) => {
      calls.push(String(url));
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Basic devin-session-token$secret-devin-session-token$secret",
      );
      if (String(url).endsWith("GetUserStatus")) {
        return new Response(Buffer.from(account));
      }
      assert.ok(String(url).endsWith("GetChatMessage"));
      const request = new Uint8Array(init!.body as Buffer);
      const proto = decodeProto(request.slice(5));
      assert.equal(new TextDecoder().decode(proto.get(21)![0] as Uint8Array), "swe-2-high");
      const message = b(3, "hello"),
        trailer = new TextEncoder().encode("{}");
      const frame = (flag: number, payload: Uint8Array) =>
        join(Uint8Array.from([flag, 0, 0, 0, payload.length]), payload);
      return new Response(Buffer.from(join(frame(0, message), frame(2, trailer))));
    },
  };
  const quota = await devin.getQuota(state, context);
  assert.ok(quota.ok);
  if (quota.ok) {
    assert.equal(quota.value.windows[1]?.remainingPercent, 80);
  }
  const response = await devin.execute(
    new Request("http://internal/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "swe-2", messages: [{ role: "user", content: "hi" }] }),
    }),
    state,
    context,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "hello");
  assert.equal(calls.length, 2);
});
test("Devin streams text and tool deltas, rejects incomplete native streams", async () => {
  const frame = (flag: number, payload: Uint8Array) =>
    join(Uint8Array.from([flag, 0, 0, 0, payload.length]), payload);
  const call = b(6, join(b(1, "call1"), b(2, "weather"), b(3, '{"city":"Paris"}')));
  const context: ProviderContext = {
    signal: new AbortController().signal,
    fetch: async () =>
      new Response(
        Buffer.from(
          join(frame(0, b(3, "hello")), frame(0, call), frame(2, new TextEncoder().encode("{}"))),
        ),
      ),
  };
  const response = await devin.execute(
    new Request("http://internal/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "swe-2",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
    state,
    context,
  );
  const content = await response.text();
  assert.match(content, /hello/);
  assert.match(content, /weather/);
  assert.match(content, /tool_calls/);
  assert.match(content, /\[DONE\]/);
  const incomplete = await devin.execute(
    new Request("http://internal/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "swe-2", messages: [{ role: "user", content: "hi" }] }),
    }),
    state,
    { ...context, fetch: async () => new Response(Buffer.from(frame(0, b(3, "hello")))) },
  );
  assert.equal(incomplete.status, 502);
});

test("Devin preserves thinking and incomplete or filtered native completion reasons", async () => {
  const frame = (flag: number, payload: Uint8Array) => {
    const header = new Uint8Array(5);
    header[0] = flag;
    new DataView(header.buffer).setUint32(1, payload.length);
    return join(header, payload);
  };
  for (const [stopReason, finish] of [
    [1, "length"],
    [3, "length"],
    [11, "content_filter"],
  ] as const) {
    for (const stream of [false, true]) {
      const response = await devin.execute(
        new Request("http://internal/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: "swe-2",
            stream,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        state,
        {
          signal: new AbortController().signal,
          fetch: async () =>
            new Response(
              Buffer.from(
                join(
                  frame(
                    0,
                    join(
                      b(9, "Thinking"),
                      b(9, " more"),
                      b(3, "partial"),
                      Uint8Array.from([40, stopReason]),
                    ),
                  ),
                  frame(2, new TextEncoder().encode("{}")),
                ),
              ),
            ),
        },
      );
      assert.equal(response.status, 200);
      if (stream) {
        const events = await response.text();
        assert.match(events, /"reasoning_content":"Thinking"/);
        assert.match(events, /"reasoning_content":" more"/);
        assert.ok(events.includes(`"finish_reason":"${finish}"`));
      } else {
        const result = await response.json();
        assert.equal(result.choices[0].message.reasoning_content, "Thinking more");
        assert.equal(result.choices[0].finish_reason, finish);
        const translated = chatCompletionToResponse(result, { model: "swe-2", input: "hello" });
        assert.equal(translated.status, "incomplete");
        assert.equal(
          translated.incomplete_details.reason,
          finish === "length" ? "max_output_tokens" : "content_filter",
        );
        assert.equal(translated.output[0].summary[0].text, "Thinking more");
      }
    }
  }
});
