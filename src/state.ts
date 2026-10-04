import { fail, ok } from "./result.js";
import type { CredentialState } from "./providers/contract.js";
import type { Result, SavedState } from "./types.js";

const providers = new Set([
  "codex",
  "claude",
  "antigravity",
  "kimi",
  "kimi-ai",
  "xai",
  "devin",
  "meta",
  "gemini",
  "gemini-interactions",
  "vertex",
  "aistudio",
  "openai-compatibility",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function decodeState(text: SavedState): Result<CredentialState> {
  try {
    const value: unknown = JSON.parse(text);
    if (!record(value)) {
      return fail("invalid-state", "Saved state is invalid.");
    }
    if (typeof value.version !== "number") {
      return fail("invalid-state", "Saved state has no version.");
    }
    if (value.version !== 1) {
      return fail("unsupported-state-version", "Saved state version is not supported.");
    }
    if (
      typeof value.provider !== "string" ||
      !providers.has(value.provider) ||
      !record(value.credentials) ||
      !(
        value.authenticatedAt === null ||
        (typeof value.authenticatedAt === "string" &&
          Number.isFinite(Date.parse(value.authenticatedAt)))
      )
    ) {
      return fail("invalid-state", "Saved state is invalid.");
    }
    return ok({
      provider: value.provider as CredentialState["provider"],
      authenticatedAt: value.authenticatedAt as string | null,
      credentials: value.credentials as CredentialState["credentials"],
    });
  } catch {
    return fail("invalid-state", "Saved state is not valid JSON.");
  }
}

export const encodeState = (state: CredentialState): SavedState =>
  JSON.stringify({ version: 1, ...state });
