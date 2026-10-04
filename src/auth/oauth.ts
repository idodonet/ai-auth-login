import { createHash, randomBytes } from "node:crypto";
import { fail } from "../result.js";
import type { Result } from "../types.js";

export function createPKCE() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    state: randomBytes(32).toString("base64url"),
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/** Internal shared lifetime: cancellation and expiry abort active network requests. */
export function authLifetime(expiresInSeconds: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const duration = Math.max(0, expiresInSeconds * 1000);
  const deadline = performance.now() + duration;
  const expiresAt = new Date(Date.now() + duration).toISOString();
  let reason: "cancelled" | "auth-expired" = "cancelled";
  const cancel = () => {
    controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  };
  const timer = setTimeout(() => {
    reason = "auth-expired";
    controller.abort();
    signal?.removeEventListener("abort", cancel);
  }, duration);
  timer.unref();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  return {
    signal: controller.signal,
    expiresAt,
    cancel,
    error<T>(): Result<T> | null {
      if (!controller.signal.aborted && performance.now() >= deadline) {
        reason = "auth-expired";
        controller.abort();
      }
      return controller.signal.aborted
        ? fail(
            reason,
            reason === "cancelled"
              ? "Authentication cancelled."
              : "Authentication session expired.",
          )
        : null;
    },
    finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    },
  };
}

export interface OAuthSessionOptions<T> {
  url: string;
  redirectURI: string;
  state: string;
  expiresInSeconds?: number;
  signal?: AbortSignal;
  exchange(code: string, signal: AbortSignal): Promise<Result<T>>;
}

export function createOAuthSession<T>(options: OAuthSessionOptions<T>) {
  const lifetime = authLifetime(options.expiresInSeconds ?? 600, options.signal);
  const redirect = new URL(options.redirectURI);
  let completion: Promise<Result<T>> | undefined;
  let consumedCallback: string | undefined;
  return {
    kind: "callback" as const,
    url: options.url,
    expiresAt: lifetime.expiresAt,
    cancel() {
      lifetime.cancel();
      lifetime.finish();
    },
    complete(callbackURL: string): Promise<Result<T>> {
      const unavailable = lifetime.error<T>();
      if (completion) {
        return callbackURL === consumedCallback
          ? completion
          : Promise.resolve(
              fail("invalid-callback", "This authentication session has already been used."),
            );
      }
      if (unavailable) {
        return Promise.resolve(unavailable);
      }
      let callback: URL;
      try {
        callback = new URL(callbackURL);
      } catch {
        return Promise.resolve(
          fail("invalid-callback", "Enter the full authentication callback URL."),
        );
      }
      if (
        callback.origin !== redirect.origin ||
        callback.pathname !== redirect.pathname ||
        callback.username ||
        callback.password ||
        callback.hash ||
        callback.searchParams.getAll("state").length !== 1 ||
        callback.searchParams.get("state") !== options.state
      ) {
        return Promise.resolve(
          fail("invalid-callback", "The callback URL does not match this authentication session."),
        );
      }
      if (callback.searchParams.has("error")) {
        consumedCallback = callbackURL;
        lifetime.finish();
        return (completion = Promise.resolve(
          fail("auth-denied", "The provider denied authentication."),
        ));
      }
      const codes = callback.searchParams.getAll("code");
      if (codes.length !== 1 || !codes[0]) {
        return Promise.resolve(
          fail("invalid-callback", "The callback URL is missing a valid authorization code."),
        );
      }
      consumedCallback = callbackURL;
      return (completion = (async () => {
        try {
          const result = await options.exchange(codes[0], lifetime.signal);
          return lifetime.error<T>() ?? result;
        } catch {
          return (
            lifetime.error<T>() ?? fail("network-error", "Unable to complete authentication.", true)
          );
        } finally {
          lifetime.finish();
        }
      })());
    },
  };
}
