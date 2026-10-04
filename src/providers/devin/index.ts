import { createHash, randomUUID } from "node:crypto";
import { authLifetime, createPKCE } from "../../auth/oauth.js";
import type { CredentialState, ProviderAdapter, ProviderContext } from "../contract.js";
import type { Result, ErrorCode } from "../../types.js";
import { encodeSSE, streamSSE } from "../../protocols/sse.js";
import { protocolError, rejectFields } from "../../protocols/openai.js";
import { executeResponses } from "../../protocols/responses.js";

const fail = <T>(code: ErrorCode, message: string, retryable = false): Result<T> => ({
  ok: false,
  error: { code, message, retryable },
});
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);
function varint(n: number): Uint8Array {
  const out: number[] = [];
  do {
    out.push((n % 128) | (n >= 128 ? 128 : 0));
    n = Math.floor(n / 128);
  } while (n);
  return Uint8Array.from(out);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
function field(n: number, value: string | Uint8Array | number): Uint8Array {
  if (typeof value === "number") {
    return concat(varint(n * 8), varint(value));
  }
  const b = typeof value === "string" ? bytes(value) : value;
  return concat(varint(n * 8 + 2), varint(b.length), b);
}
/** Strict minimal protobuf decoder: malformed lengths/tags are errors, unknown fixed fields are skipped. */
export function decodeProto(data: Uint8Array): Map<number, (Uint8Array | number)[]> {
  let at = 0;
  const read = () => {
    let n = 0;
    for (let i = 0; i < 10; i++) {
      if (at >= data.length) {
        throw new Error("Truncated protobuf");
      }
      const b = data[at++]!;
      n += (b & 127) * 2 ** (i * 7);
      if (!(b & 128)) {
        if (!Number.isSafeInteger(n)) {
          throw new Error("Unsafe protobuf integer");
        }
        return n;
      }
    }
    throw new Error("Invalid protobuf varint");
  };
  const out = new Map<number, (Uint8Array | number)[]>();
  while (at < data.length) {
    const tag = read(),
      n = Math.floor(tag / 8),
      wire = tag % 8;
    if (!n) {
      throw new Error("Invalid protobuf tag");
    }
    let value: number | Uint8Array;
    if (wire === 0) {
      value = read();
    } else {
      const size = wire === 2 ? read() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (size < 0 || at + size > data.length) {
        throw new Error("Invalid protobuf length");
      }
      value = data.slice(at, at + size);
      at += size;
    }
    const values = out.get(n) ?? [];
    values.push(value);
    out.set(n, values);
  }
  return out;
}
function nested(m: ReturnType<typeof decodeProto>, n: number) {
  const v = m.get(n)?.[0];
  return v instanceof Uint8Array ? decodeProto(v) : new Map<number, (Uint8Array | number)[]>();
}
function str(m: ReturnType<typeof decodeProto>, n: number): string | null {
  const v = m.get(n)?.[0];
  return v instanceof Uint8Array ? text(v) : null;
}
function num(m: ReturnType<typeof decodeProto>, n: number): number | null {
  const v = m.get(n)?.[0];
  return typeof v === "number" ? v : null;
}
function date(n: number | null): string | null {
  return n !== null && n > 0 && n < 8640000000000 ? new Date(n * 1000).toISOString() : null;
}
export function parseUserStatus(data: Uint8Array) {
  const root = decodeProto(data);
  if (!root.has(1)) {
    throw new Error("Missing user status");
  }
  const user = nested(root, 1),
    plan = nested(user, 13),
    info = nested(plan, 1);
  const percent = (n: number) => {
    const v = num(plan, n);
    return v !== null && v >= 0 && v <= 100 ? v : null;
  };
  return {
    email: str(user, 7),
    id: str(user, 36),
    plan: str(info, 2),
    daily: percent(14),
    weekly: percent(15),
    dailyReset: date(num(plan, 17)),
    weeklyReset: date(num(plan, 18)),
  };
}
function metadata(token: string) {
  let fingerprint = "";
  for (let i = 0; fingerprint.length < 732; i++) {
    fingerprint += createHash("sha256").update(`${token}-${i}`).digest("hex");
  }
  return concat(
    field(1, "chisel"),
    field(2, "3000.10.21"),
    field(3, token),
    field(4, "en"),
    field(5, process.platform === "win32" ? "windows" : process.platform),
    field(7, "3000.10.21"),
    field(12, "chisel"),
    field(31, fingerprint.slice(0, 732)),
  );
}
function token(state: CredentialState) {
  const v = state.credentials.sessionToken;
  return typeof v === "string" ? v : "";
}
function saved(value: string): CredentialState {
  return {
    provider: "devin",
    authenticatedAt: new Date().toISOString(),
    credentials: {
      sessionToken: value.startsWith("devin-session-token$")
        ? value
        : `devin-session-token$${value}`,
    },
  };
}
async function status(state: CredentialState, context: ProviderContext) {
  const t = token(state);
  if (!t) {
    return fail<ReturnType<typeof parseUserStatus>>(
      "auth-required",
      "Devin session token is missing",
    );
  }
  try {
    const response = await context.fetch(
      "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${t}-${t}`,
          "Connect-Protocol-Version": "1",
          "Content-Type": "application/proto",
          Accept: "*/*",
          "User-Agent": "",
        },
        body: Buffer.from(field(1, metadata(t))),
        signal: context.signal,
      },
    );
    if (!response.ok) {
      return fail<ReturnType<typeof parseUserStatus>>(
        response.status === 401 || response.status === 403 ? "auth-required" : "provider-error",
        `Devin status request failed (${response.status})`,
        response.status >= 500,
      );
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length > 4 * 1024 * 1024) {
      return fail<ReturnType<typeof parseUserStatus>>(
        "provider-error",
        "Devin status response is too large",
      );
    }
    return ok(parseUserStatus(data));
  } catch {
    return fail<ReturnType<typeof parseUserStatus>>(
      context.signal.aborted ? "cancelled" : "provider-error",
      "Unable to read Devin account status",
      !context.signal.aborted,
    );
  }
}
const modelIDs: string[] = [
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-sonnet-5",
  "gemini-3-8-flash",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "glm-5-2",
  "kimi-k3",
  "glm-5-3",
  "swe-1-7-lightning",
  "swe-2",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-5-fable",
  "gemini-3-5-flash",
  "gemini-3-6-flash",
  "gemini-3-7-flash",
  "gpt-5-6-sol",
  "gpt-5-6-terra",
  "gpt-5-6-luna",
  "glm-5-2-1m",
  "grok-4-5",
  "grok-4-6",
  "grok-4-7",
  "inkling",
  "glm-5-3-flash",
  "deepseek-v4-flash",
  "deepseek-v4-1-flash",
  "swe-1-7",
  "claude-opus-4-6",
  "claude-opus-4-6-1m",
  "gpt-5-4",
  "gpt-5-5",
  "gpt-5-4-mini",
  "claude-sonnet-4-6",
  "claude-sonnet-4-6-1m",
  "MODEL_GPT_5_2",
  "MODEL_CLAUDE_4_5_OPUS",
  "MODEL_PRIVATE_11",
  "MODEL_PRIVATE_2",
  "MODEL_PRIVATE_3",
  "MODEL_CHAT_GPT_4_1_2025_04_14",
  "MODEL_PRIVATE_12",
  "MODEL_PRIVATE_13",
  "MODEL_PRIVATE_14",
  "MODEL_PRIVATE_15",
  "gpt-5-3-codex",
  "kimi-k2-6",
  "kimi-k2-7",
  "nemotron-3-ultra",
  "swe-1-6",
  "gemini-3-1-pro",
  "MODEL_GOOGLE_GEMINI_3_0_FLASH",
  "deepseek-v4-pro",
];

const modelLevels: Record<string, string[]> = {
  "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "gemini-3-8-flash": ["low", "medium", "high"],
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "glm-5-2": ["none", "max"],
  "kimi-k3": ["low", "high", "max"],
  "glm-5-3": ["low", "high", "max"],
  "swe-1-7-lightning": ["medium"],
  "swe-2": ["medium", "high", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-5-fable": ["low", "medium", "high", "xhigh", "max"],
  "gemini-3-5-flash": ["minimal", "low", "medium", "high"],
  "gemini-3-6-flash": ["minimal", "low", "medium", "high"],
  "gemini-3-7-flash": ["low", "medium", "high"],
  "gpt-5-6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5-6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "glm-5-2-1m": ["none", "max"],
  "grok-4-5": ["low", "medium", "high"],
  "grok-4-6": ["low", "medium", "high", "xhigh"],
  "grok-4-7": ["low", "medium", "high", "xhigh"],
  inkling: ["none", "low", "medium", "high", "xhigh", "max"],
  "glm-5-3-flash": ["low", "high", "max"],
  "deepseek-v4-flash": ["high", "max"],
  "deepseek-v4-1-flash": ["high", "max"],
  "swe-1-7": ["medium"],
  "claude-opus-4-6": [],
  "claude-opus-4-6-1m": [],
  "gpt-5-4": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5-5": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5-4-mini": ["low", "medium", "high", "xhigh"],
  "claude-sonnet-4-6": [],
  "claude-sonnet-4-6-1m": [],
  MODEL_GPT_5_2: ["none", "low", "medium", "high", "xhigh"],
  MODEL_CLAUDE_4_5_OPUS: ["high"],
  MODEL_PRIVATE_11: [],
  MODEL_PRIVATE_2: [],
  MODEL_PRIVATE_3: [],
  MODEL_CHAT_GPT_4_1_2025_04_14: [],
  MODEL_PRIVATE_12: [],
  MODEL_PRIVATE_13: [],
  MODEL_PRIVATE_14: [],
  MODEL_PRIVATE_15: [],
  "gpt-5-3-codex": ["low", "medium", "high", "xhigh"],
  "kimi-k2-6": [],
  "kimi-k2-7": [],
  "nemotron-3-ultra": ["none", "medium", "high"],
  "swe-1-6": [],
  "gemini-3-1-pro": ["low", "high"],
  MODEL_GOOGLE_GEMINI_3_0_FLASH: ["minimal", "low", "medium", "high"],
  "deepseek-v4-pro": ["high", "max"],
};
export const devin: ProviderAdapter = {
  descriptor: {
    id: "devin",
    name: "Devin",
    authMethods: ["callback", "api-key"],
    endpoints: ["models", "chat.completions", "responses"],
    quota: true,
    modelDiscovery: "catalog",
  },
  async beginAuth(context, options) {
    if (options?.method === "device") {
      return fail("unsupported", "Devin uses browser authorization");
    }
    const pkce = createPKCE(),
      lifetime = authLifetime(600, context.signal);
    let done = false,
      busy = false;
    const url = new URL("https://app.devin.ai/auth/cli/continue");
    for (const [k, v] of Object.entries({
      state: pkce.state,
      prompt: "select_account",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      cli_pkce_marker: "1",
    })) {
      url.searchParams.set(k, v);
    }
    return ok({
      kind: "callback",
      url: url.href,
      expiresAt: lifetime.expiresAt,
      cancel() {
        done = true;
        lifetime.cancel();
        lifetime.finish();
      },
      async complete(input) {
        if (busy) {
          return fail("invalid-callback", "Devin token exchange is already running");
        }
        const unavailable = lifetime.error<CredentialState>();
        if (unavailable) {
          return unavailable;
        }
        if (done) {
          return fail("cancelled", "Devin login was cancelled");
        }
        let code = input.trim();
        if (!code) {
          return fail("invalid-callback", "Enter the authorization code or callback URL");
        }
        if (
          code.startsWith("devin-session-token$") ||
          /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(code)
        ) {
          done = true;
          lifetime.finish();
          return ok(saved(code));
        }
        if (/^https?:/i.test(code)) {
          try {
            const callback = new URL(code);
            if (callback.searchParams.get("state") !== pkce.state) {
              return fail("invalid-callback", "Authorization state does not match");
            }
            if (callback.searchParams.has("error")) {
              return fail("auth-denied", "Devin authorization was denied");
            }
            code = callback.searchParams.get("code") ?? "";
          } catch {
            return fail("invalid-callback", "Invalid callback URL");
          }
        }
        if (!code) {
          return fail("invalid-callback", "Authorization code is missing");
        }
        busy = true;
        try {
          const response = await context.fetch("https://api.devin.ai/auth/cli/token", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ code, code_verifier: pkce.verifier }),
            signal: lifetime.signal,
          });
          const expired = lifetime.error<CredentialState>();
          if (expired) {
            return expired;
          }
          if (!response.ok) {
            return fail("auth-denied", `Devin token exchange failed (${response.status})`);
          }
          const value = (await response.json()) as { token?: unknown };
          const unavailable = lifetime.error<CredentialState>();
          if (unavailable) {
            return unavailable;
          }
          if (typeof value.token !== "string" || !value.token.trim()) {
            return fail("provider-error", "Devin returned no session token");
          }
          if (done) {
            return fail("cancelled", "Devin login was cancelled");
          }
          done = true;
          lifetime.finish();
          return ok(saved(value.token));
        } catch {
          return (
            lifetime.error<CredentialState>() ??
            fail("network-error", "Devin token exchange could not complete", true)
          );
        } finally {
          busy = false;
        }
      },
    });
  },
  async connect(input) {
    return input.kind === "api-key" && input.apiKey.trim() && !input.baseURL
      ? ok(saved(input.apiKey.trim()))
      : fail("unsupported", "Provide a Devin session token without a custom endpoint");
  },
  async checkAuth(state, context, options) {
    if (!token(state).trim()) {
      return fail("auth-required", "Devin session token is missing");
    }
    if (options?.validate === false) {
      return ok(state);
    }
    const result = await status(state, context);
    return result.ok ? ok(state) : result;
  },
  async getAccount(state, context) {
    const result = await status(state, context);
    return result.ok
      ? ok({
          id: result.value.id,
          email: result.value.email,
          plan: result.value.plan,
          isFree: result.value.plan === null ? null : /free/i.test(result.value.plan),
          lastAuthenticatedAt: state.authenticatedAt,
        })
      : result;
  },
  async getQuota(state, context) {
    const result = await status(state, context);
    if (!result.ok) {
      return result;
    }
    return ok({
      supported: true,
      checkedAt: new Date().toISOString(),
      windows: [
        ["daily", 86400, result.value.daily, result.value.dailyReset],
        ["weekly", 604800, result.value.weekly, result.value.weeklyReset],
      ].map(([name, durationSeconds, remainingPercent, resetsAt]) => ({
        name: name as string,
        durationSeconds: durationSeconds as number,
        remainingPercent: remainingPercent as number | null,
        resetsAt: resetsAt as string | null,
        model: null,
        remaining: null,
        limit: null,
        unit: null,
      })),
    });
  },
  async listModels() {
    return ok(
      modelIDs.map((id) => ({ id, object: "model" as const, created: 0, owned_by: "devin" })),
    );
  },
  async execute(request, state, context) {
    return execute(request, state, context);
  },
};

function floating(n: number, value: number) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value, true);
  return concat(varint(n * 8 + 1), b);
}
function chatPayload(body: Record<string, any>, t: string) {
  rejectFields(body, [
    "model",
    "messages",
    "stream",
    "stream_options",
    "temperature",
    "max_tokens",
    "max_completion_tokens",
    "tools",
    "tool_choice",
    "reasoning_effort",
    "n",
  ]);
  if (body.n !== undefined && body.n !== 1) {
    throw new Error("Devin supports n=1");
  }
  if (body.tool_choice && body.tool_choice !== "auto") {
    throw new Error("Devin does not support forced tool selection");
  }
  if (!Array.isArray(body.messages) || typeof body.model !== "string" || !body.model) {
    throw new Error("Devin requires model and messages");
  }
  const parts = [field(1, metadata(t))];
  const system: string[] = [];
  for (const message of body.messages) {
    if (!["system", "developer", "assistant", "user", "tool"].includes(message.role)) {
      throw new Error("Unsupported Devin message role");
    }
    if (message.role === "system" || message.role === "developer") {
      if (typeof message.content !== "string") {
        throw new Error("System content must be text");
      }
      system.push(message.content);
      continue;
    }
    const prompt = [
      field(1, randomUUID()),
      field(2, message.role === "assistant" ? 2 : message.role === "tool" ? 4 : 1),
    ];
    if (typeof message.content === "string" || message.content == null) {
      prompt.push(field(3, message.content ?? ""));
    } else if (Array.isArray(message.content)) {
      const texts: string[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          texts.push(part.text);
        } else if (part.type === "image_url" && typeof part.image_url?.url === "string") {
          const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(
            part.image_url.url,
          );
          if (!match) {
            throw new Error("Devin images require base64 data URLs");
          }
          prompt.push(field(10, concat(field(1, match[2]!), field(2, match[1]!))));
        } else {
          throw new Error("Unsupported Devin content");
        }
      }
      prompt.push(field(3, texts.join("\n")));
    } else {
      throw new Error("Invalid Devin message content");
    }
    for (const call of message.tool_calls ?? []) {
      if (call.type !== "function") {
        throw new Error("Devin supports function tools");
      }
      prompt.push(
        field(
          6,
          concat(
            field(1, call.id),
            field(2, call.function.name),
            field(3, call.function.arguments),
          ),
        ),
      );
    }
    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string") {
        throw new Error("Tool call id is required");
      }
      prompt.push(field(7, message.tool_call_id));
    }
    parts.push(field(3, concat(...prompt)));
  }
  if (system.length) {
    parts.push(field(2, system.join("\n")));
  }
  const max = body.max_completion_tokens ?? body.max_tokens ?? 16384;
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new Error("Invalid maximum token count");
  }
  const temperature = body.temperature ?? 1;
  if (typeof temperature !== "number" || !Number.isFinite(temperature)) {
    throw new Error("Invalid temperature");
  }
  parts.push(
    field(7, 5),
    field(
      8,
      concat(
        field(1, 1),
        field(2, max),
        field(3, 400),
        floating(5, temperature),
        field(7, 40),
        floating(8, 0.95),
      ),
    ),
  );
  for (const tool of body.tools ?? []) {
    if (tool.type !== "function" || typeof tool.function?.name !== "string") {
      throw new Error("Devin supports function tools");
    }
    parts.push(
      field(
        10,
        concat(
          field(1, tool.function.name),
          field(2, tool.function.description ?? ""),
          field(3, JSON.stringify(tool.function.parameters ?? {})),
        ),
      ),
    );
  }
  const id = randomUUID();
  parts.push(
    field(15, concat(field(1, id), field(3, 4), field(4, 14))),
    field(16, id),
    field(20, 1),
  );
  let model: string = body.model.replace(/^devin\//i, "");
  const effort: string | undefined = body.reasoning_effort;
  if (model === "gpt-4-1") {
    model = "MODEL_CHAT_GPT_4_1_2025_04_14";
  } else if (model === "claude-haiku-4-5") {
    model = "MODEL_PRIVATE_11";
  } else if (model === "MODEL_GPT_5_2") {
    model += `_${(effort ?? "low").toUpperCase()}`;
  } else if (model === "MODEL_GOOGLE_GEMINI_3_0_FLASH") {
    model += `_${(effort ?? "high").toUpperCase()}`;
  } else if (model === "MODEL_CLAUDE_4_5_OPUS") {
    if (effort && effort !== "none") {
      model += "_THINKING";
    }
  } else if (["swe-1-7", "swe-1-6", "glm-5-2", "glm-5-2-1m"].includes(model)) {
    if (model === "swe-1-7" && effort === "medium") {
      model += "-medium";
    } else if (model === "swe-1-6" && effort === "fast") {
      model += "-fast";
    } else if (model.startsWith("glm-5-2") && ["none", "max"].includes(effort ?? "")) {
      model = model === "glm-5-2-1m" ? `glm-5-2-${effort}-1m` : `${model}-${effort}`;
    }
  } else if (/^claude-(opus|sonnet)-4-6(-1m)?$/.test(model)) {
    if (effort && effort !== "none") {
      model = model.endsWith("-1m") ? model.replace(/-1m$/, "-thinking-1m") : `${model}-thinking`;
    }
  } else {
    const levels = modelLevels[model];
    if (levels?.length) {
      if (effort && !levels.includes(effort)) {
        throw new Error("Unsupported reasoning effort for Devin model");
      }
      const fallback =
        model === "swe-2"
          ? "high"
          : model.startsWith("gpt-5") && levels.includes("none") && levels.includes("low")
            ? "low"
            : /gemini|grok|glm|deepseek|kimi|nemotron/.test(model) && levels.includes("high")
              ? "high"
              : (["medium", "high", "low"].find((v) => levels.includes(v)) ?? levels[0]);
      model += `-${effort ?? fallback}`;
    }
  }
  parts.push(field(21, model));
  const payload = concat(...parts),
    header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(1, payload.length);
  return concat(header, payload);
}
async function* frames(response: Response, signal: AbortSignal) {
  if (!response.body) {
    throw new Error("Missing Devin stream");
  }
  const reader = response.body.getReader();
  let buffer: Uint8Array = new Uint8Array(0),
    ended = false;
  const abort = () => {
    void reader.cancel();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer = concat(buffer, chunk.value);
      while (buffer.length >= 5) {
        const length = new DataView(buffer.buffer, buffer.byteOffset + 1, 4).getUint32(0);
        if (length > 16 * 1024 * 1024) {
          throw new Error("Devin frame too large");
        }
        if (buffer.length < length + 5) {
          break;
        }
        const flag = buffer[0]!,
          payload = buffer.slice(5, 5 + length);
        buffer = buffer.slice(5 + length);
        if (flag & 1) {
          throw new Error("Compressed Devin frame unsupported");
        }
        if (flag & 2) {
          const trailer = JSON.parse(text(payload));
          if (trailer.error) {
            throw new Error("Devin stream failed");
          }
          ended = true;
        } else {
          yield decodeProto(payload);
        }
      }
    }
    if (buffer.length || !ended) {
      throw new Error("Truncated Devin stream");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function nativeChat(
  body: Record<string, any>,
  state: CredentialState,
  context: ProviderContext,
  signal: AbortSignal,
): Promise<Response> {
  const t = token(state);
  if (!t) {
    return protocolError("Devin authentication required", 401);
  }
  let payload: Uint8Array;
  try {
    payload = chatPayload(body, t);
  } catch (error) {
    return protocolError(error instanceof Error ? error.message : "Invalid Devin request");
  }
  const response = await context.fetch(
    "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${t}-${t}`,
        "Content-Type": "application/connect+proto",
        "Connect-Protocol-Version": "1",
        Accept: "*/*",
        "User-Agent": "",
      },
      body: Buffer.from(payload),
      signal,
    },
  );
  if (!response.ok) {
    return response;
  }
  const id = `chatcmpl-${randomUUID()}`,
    created = Math.floor(Date.now() / 1000),
    tools = new Map<string, any>();
  let content = "",
    reasoning = "",
    stopReason = 0,
    usage: Record<string, number> | undefined;
  const finishReason = () =>
    stopReason === 1 || stopReason === 3
      ? "length"
      : stopReason === 11
        ? "content_filter"
        : tools.size
          ? "tool_calls"
          : "stop";
  const chunk = (delta: any, finish_reason: string | null = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: body.model,
    choices: [{ index: 0, delta, finish_reason }],
  });
  async function* events() {
    yield encodeSSE(undefined, chunk({ role: "assistant", content: "" }));
    for await (const frame of frames(response, signal)) {
      stopReason = num(frame, 5) || stopReason;
      for (const thought of frame.get(9) ?? []) {
        if (thought instanceof Uint8Array) {
          const delta = text(thought);
          reasoning += delta;
          yield encodeSSE(undefined, chunk({ reasoning_content: delta }));
        }
      }
      const delta = str(frame, 3);
      if (delta) {
        content += delta;
        yield encodeSSE(undefined, chunk({ content: delta }));
      }
      for (const raw of frame.get(6) ?? []) {
        if (!(raw instanceof Uint8Array)) {
          continue;
        }
        const call = decodeProto(raw),
          callId = str(call, 1);
        if (!callId) {
          throw new Error("Devin tool call missing id");
        }
        let tool = tools.get(callId);
        const first = !tool;
        if (!tool) {
          tool = {
            index: tools.size,
            id: callId,
            type: "function",
            function: { name: str(call, 2) ?? "", arguments: "" },
          };
          tools.set(callId, tool);
        }
        const args = str(call, 3) ?? "";
        tool.function.arguments += args;
        yield encodeSSE(
          undefined,
          chunk({
            tool_calls: [
              {
                index: tool.index,
                ...(first ? { id: callId, type: "function" } : {}),
                function: { ...(str(call, 2) ? { name: str(call, 2) } : {}), arguments: args },
              },
            ],
          }),
        );
      }
      if (frame.has(7)) {
        const u = nested(frame, 7),
          input = (num(u, 2) ?? 0) + (num(u, 4) ?? 0) + (num(u, 5) ?? 0),
          output = num(u, 3) ?? 0;
        const http = num(u, 6);
        if (http !== null && http >= 400) {
          throw new Error(`Devin upstream model error (${http})`);
        }
        usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
      }
    }
    yield encodeSSE(undefined, chunk({}, finishReason()));
    if (body.stream_options?.include_usage && usage) {
      yield encodeSSE(undefined, {
        id,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [],
        usage,
      });
    }
    yield encodeSSE(undefined, "[DONE]");
  }
  if (body.stream) {
    return streamSSE(events());
  }
  try {
    for await (const _ of events()) {
      /* consume native framed stream */
    }
    return Response.json({
      id,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: content || null,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(tools.size
              ? { tool_calls: [...tools.values()].map(({ index, ...tool }) => tool) }
              : {}),
          },
          finish_reason: finishReason(),
        },
      ],
      ...(usage ? { usage } : {}),
    });
  } catch {
    return protocolError("Devin stream could not complete", 502);
  }
}
async function execute(
  request: Request,
  state: CredentialState,
  context: ProviderContext,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/v1/responses") {
    return executeResponses(request, (body, signal) =>
      nativeChat(body, state, context, AbortSignal.any([signal, context.signal])),
    );
  }
  if (path !== "/v1/chat/completions" || request.method !== "POST") {
    return protocolError("Unsupported Devin endpoint", 404);
  }
  try {
    return await nativeChat(
      await request.json(),
      state,
      context,
      AbortSignal.any([request.signal, context.signal]),
    );
  } catch {
    return protocolError("Unable to complete Devin request", 502);
  }
}

export const createProvider = (): ProviderAdapter => devin;
