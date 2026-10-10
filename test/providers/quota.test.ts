import test from "node:test";
import assert from "node:assert/strict";
import { antigravity } from "../../src/providers/antigravity/index.js";
import { claude } from "../../src/providers/claude/index.js";
import { xai } from "../../src/providers/xai/index.js";
import { kimi, kimiAI } from "../../src/providers/kimi/index.js";
import { meta } from "../../src/providers/meta/index.js";
import { codex } from "../../src/providers/codex/index.js";
import { ProviderSession } from "../../src/session.js";
import { encodeState } from "../../src/state.js";
import type {
  ProviderAdapter,
  CredentialState,
  ProviderContext,
} from "../../src/providers/contract.js";

const state = (adapter: ProviderAdapter): CredentialState => ({
  provider: adapter.descriptor.id,
  authenticatedAt: null,
  credentials: {
    ...(adapter === meta ? { apiKey: "fixture" } : {}),
    accessToken: "fixture",
    access_token: "fixture",
    project: "project",
    dcaToken: "dca:fixture",
    expiresAt:
      adapter === antigravity || adapter === claude
        ? new Date(Date.now() + 3600000).toISOString()
        : Date.now() + 3600000,
  },
});
const context = (fetch: ProviderContext["fetch"]): ProviderContext => ({
  fetch,
  signal: new AbortController().signal,
});
const reset = "2026-10-17T00:00:00.000Z";

test("subscription quota adapters return provider data through public sessions without counting SDK usage", async () => {
  for (const adapter of [antigravity, claude, xai, kimi, kimiAI, meta, codex]) {
    const urls: string[] = [];
    const session = new ProviderSession({
      state: encodeState(state(adapter)),
      fetch: async (input, init) => {
        const url = String(input);
        urls.push(url);
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          `Bearer ${adapter === meta ? "dca:fixture" : "fixture"}`,
        );
        if (adapter !== codex) assert.equal(init?.redirect, "error");
        if (adapter === antigravity) {
          assert.ok(url.endsWith(":retrieveUserQuotaSummary"));
          assert.deepEqual(JSON.parse(String(init?.body)), { project: "project" });
          return Response.json({
            groups: [
              {
                displayName: "Gemini",
                buckets: [
                  { window: "5h", remainingFraction: "0.8", resetTime: reset },
                  { window: "weekly", remainingFraction: 0 },
                ],
              },
            ],
          });
        }
        if (adapter === claude) {
          assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
          return Response.json({
            five_hour: { utilization: "20", resets_at: reset },
            seven_day_sonnet: { utilization: 100 },
            extra_usage: {
              is_enabled: true,
              monthly_limit: 1000,
              used_credits: 200,
              utilization: 20,
            },
          });
        }
        if (adapter === xai)
          return Response.json({
            config: url.endsWith("?format=credits")
              ? { creditUsagePercent: 20, currentPeriod: { end: reset } }
              : {
                  monthlyLimit: { val: 1000 },
                  used: { val: 200 },
                  onDemandCap: { val: 100 },
                  onDemandUsed: { val: 0 },
                  billingPeriodEnd: reset,
                },
          });
        if (adapter === kimi || adapter === kimiAI) {
          assert.equal(
            url,
            `https://api.${adapter === kimi ? "kimi.com" : "kimi.ai"}/coding/v1/usages`,
          );
          return Response.json({
            limits: [
              {
                window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
                detail: { limit: "100", remaining: "80", reset_time: reset },
              },
            ],
            usage: { limit: 100, used: 100 },
            usages: { limit_month_total: { used_ratio: 0.2, reset_time: reset } },
          });
        }
        if (adapter === meta) {
          assert.equal(url, "https://api.meta.ai/muse-code/key");
          assert.equal(init?.body, "{}");
          return Response.json({
            api_key: "must-not-leak",
            subs_usage: {
              window: {
                used_percent: "20",
                window_duration_mins: 300,
                resets_at: Date.parse(reset) / 1000,
              },
              weekly: { used_percent: 100 },
            },
          });
        }
        assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 20,
              limit_window_seconds: 18000,
              reset_at: Date.parse(reset) / 1000,
            },
          },
          credits: { balance: "12" },
        });
      },
    });
    try {
      const result = await session.getQuota();
      assert.ok(result.ok, adapter.descriptor.id);
      assert.equal(result.value.supported, true);
      assert.equal(result.value.windows[0].remainingPercent, 80);
      assert.equal(result.value.windows[0].resetsAt, reset);
      if (adapter !== xai) assert.equal(result.value.windows[0].durationSeconds, 18000);
      assert.equal(session.getStats().requestsSent, 0);
      assert.equal(session.getStats().requestsFailed, 0);
      assert.ok(!JSON.stringify(result).includes("must-not-leak"));
      assert.equal(adapter.descriptor.quota, true);
      assert.equal(urls.length, adapter === xai ? 2 : 1);
    } finally {
      await session.close();
    }
  }
});

test("quota endpoints preserve HTTP failures and never expose upstream secrets", async () => {
  for (const adapter of [antigravity, claude, xai, kimi, kimiAI, meta]) {
    for (const [status, code] of [
      [401, "auth-required"],
      [429, "rate-limited"],
      [503, "provider-error"],
    ] as const) {
      const result = await adapter.getQuota(
        state(adapter),
        context(async () => new Response("secret", { status })),
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, code);
        assert.ok(!result.error.message.includes("secret"));
      }
    }
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.getQuota(state(adapter), {
      signal: controller.signal,
      fetch: async () => {
        throw controller.signal.reason;
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "cancelled");
    const malformed = await adapter.getQuota(
      state(adapter),
      context(async () => new Response("secret-invalid-json")),
    );
    assert.equal(malformed.ok, false);
    if (!malformed.ok) {
      assert.equal(malformed.error.code, "provider-error");
      assert.ok(!malformed.error.message.includes("secret"));
    }
  }
});

test("quota distinguishes unsupported credential types from supported but unknown data", async () => {
  for (const adapter of [claude, xai, meta, codex]) {
    const result = await adapter.getQuota(
      { ...state(adapter), credentials: { apiKey: "fixture" } },
      context(async () => {
        throw new Error("must not fetch");
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.value.supported, false);
  }
  for (const adapter of [claude, meta, kimi, xai]) {
    const result = await adapter.getQuota(
      state(adapter),
      context(async () => Response.json({})),
    );
    assert.ok(result.ok);
    assert.equal(result.value.supported, true);
    assert.ok(result.value.windows.every((w) => w.remainingPercent === null));
  }
});

test("Antigravity quota falls back to its fixed production endpoint", async () => {
  const urls: string[] = [];
  const result = await antigravity.getQuota(
    state(antigravity),
    context(async (input) => {
      urls.push(String(input));
      return urls.length < 3 ? new Response("", { status: 404 }) : Response.json({ groups: [] });
    }),
  );
  assert.ok(result.ok);
  assert.equal(result.value.supported, true);
  assert.equal(urls[2], "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary");
});
