import { fail, ok } from "../result.js";
import type { Quota, QuotaWindow, Result } from "../types.js";
import type { ProviderContext } from "./contract.js";

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const number = (value: unknown): number | null => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
export const percent = (value: number | null): number | null =>
  value === null ? null : Math.max(0, Math.min(100, value));
export const timestamp = (value: unknown): string | null => {
  const ms =
    typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value * 1000 : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
};
export const window = (name: string, fields: Partial<QuotaWindow> = {}): QuotaWindow => ({
  name,
  model: null,
  durationSeconds: null,
  remainingPercent: null,
  remaining: null,
  limit: null,
  unit: null,
  resetsAt: null,
  ...fields,
});
export const quota = (windows: QuotaWindow[], supported = true): Result<Quota> =>
  ok({ supported, checkedAt: new Date().toISOString(), windows });

/** Do not include upstream bodies in errors: billing endpoints may return credentials. */
export async function quotaJSON(
  context: ProviderContext,
  url: string,
  init: RequestInit,
): Promise<Result<Record<string, unknown>>> {
  try {
    context.signal.throwIfAborted();
    const response = await context.fetch(url, {
      ...init,
      signal: context.signal,
      redirect: "error",
    });
    if (!response.ok)
      return fail(
        response.status === 401 || response.status === 403
          ? "auth-required"
          : response.status === 429
            ? "rate-limited"
            : "provider-error",
        `Quota request failed (${response.status}).`,
        response.status === 429 || response.status >= 500,
      );
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      context.signal.throwIfAborted();
      return fail("provider-error", "Invalid quota response.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail("provider-error", "Invalid quota response.");
    return ok(record(value));
  } catch {
    return fail(
      context.signal.aborted ? "cancelled" : "network-error",
      context.signal.aborted ? "Quota request cancelled." : "Could not retrieve quota.",
      !context.signal.aborted,
    );
  }
}
