import type { ErrorCode, Result } from "./types.js";
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(
  code: ErrorCode,
  message: string,
  retryable = false,
): Result<T> => ({ ok: false, error: { code, message, retryable } });
