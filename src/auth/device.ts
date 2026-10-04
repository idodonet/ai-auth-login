import { setTimeout as delay } from "node:timers/promises";
import { fail } from "../result.js";
import type { Result } from "../types.js";
import { authLifetime } from "./oauth.js";

export interface DeviceSessionOptions<T> {
  url: string;
  userCode?: string | null;
  expiresInSeconds: number;
  intervalSeconds?: number;
  signal?: AbortSignal;
  poll(signal: AbortSignal): Promise<Result<T> | { pending: true; slowDown?: boolean }>;
}

export function createDeviceSession<T>(options: DeviceSessionOptions<T>) {
  const lifetime = authLifetime(options.expiresInSeconds, options.signal);
  let interval = Math.max(0.001, options.intervalSeconds ?? 5) * 1000;
  let waiting: Promise<Result<T>> | undefined;
  async function poll(): Promise<Result<T>> {
    try {
      for (;;) {
        const unavailable = lifetime.error<T>();
        if (unavailable) {
          return unavailable;
        }
        await delay(interval, undefined, { signal: lifetime.signal });
        const expired = lifetime.error<T>();
        if (expired) {
          return expired;
        }
        const result = await options.poll(lifetime.signal);
        const cancelled = lifetime.error<T>();
        if (cancelled) {
          return cancelled;
        }
        if (!("pending" in result)) {
          return result;
        }
        if (result.slowDown) {
          interval += 5000;
        }
      }
    } catch {
      return (
        lifetime.error<T>() ?? fail("network-error", "Unable to check device authentication.", true)
      );
    } finally {
      lifetime.finish();
    }
  }
  return {
    kind: "device" as const,
    url: options.url,
    userCode: options.userCode ?? null,
    expiresAt: lifetime.expiresAt,
    wait(): Promise<Result<T>> {
      return (waiting ??= poll());
    },
    cancel() {
      lifetime.cancel();
      lifetime.finish();
    },
  };
}
