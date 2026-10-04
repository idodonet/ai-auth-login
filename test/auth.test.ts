import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPKCE, createOAuthSession } from "../src/auth/oauth.js";
import { createDeviceSession } from "../src/auth/device.js";
import { ok } from "../src/result.js";

const url = "https://provider.example/auth";
const redirectURI = "http://localhost:1455/auth/callback";
const callback = `${redirectURI}?state=expected&code=secret`;

test("PKCE uses unique random state and an S256 challenge", () => {
  const first = createPKCE();
  const second = createPKCE();
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.verifier, second.verifier);
  assert.ok(first.verifier.length >= 43);
  assert.equal(first.challenge, createHash("sha256").update(first.verifier).digest("base64url"));
});

test("OAuth rejects mismatched and ambiguous callbacks without consuming login", async () => {
  let calls = 0;
  const login = createOAuthSession({
    url,
    redirectURI,
    state: "expected",
    exchange: async (code) => {
      calls++;
      return ok(code);
    },
  });
  for (const invalid of [
    "secret",
    callback.replace("localhost", "evil.example"),
    callback.replace("auth/callback", "other"),
    callback.replace("expected", "wrong"),
    callback + "&state=expected",
    callback + "&code=other",
    callback + "#fragment",
    `${redirectURI}?state=expected`,
  ]) {
    const result = await login.complete(invalid);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid-callback");
    }
  }
  assert.equal(calls, 0);
  assert.deepEqual(await login.complete(callback), ok("secret"));
  assert.equal(calls, 1);
  assert.deepEqual(await login.complete(callback), ok("secret"));
  assert.equal(calls, 1);
  login.cancel();
});

test("OAuth denial is safe and terminal", async () => {
  const login = createOAuthSession({
    url,
    redirectURI,
    state: "expected",
    exchange: async () => {
      throw new Error("Must not exchange");
    },
  });
  const result = await login.complete(
    `${redirectURI}?state=expected&error=secret&error_description=token`,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "auth-denied");
    assert.ok(!result.error.message.includes("secret"));
  }
  assert.equal((await login.complete(callback)).ok, false);
});

test("OAuth expiry and cancellation stop pending exchange", async () => {
  const expired = createOAuthSession({
    url,
    redirectURI,
    state: "expected",
    expiresInSeconds: 0,
    exchange: async () => ok(1),
  });
  const result = await expired.complete(callback);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "auth-expired");
  }
  const login = createOAuthSession({
    url,
    redirectURI,
    state: "expected",
    exchange: async (_code, signal) =>
      new Promise<ResultNumber>((resolve) =>
        signal.addEventListener("abort", () => resolve(ok(1)), { once: true }),
      ),
  });
  const pending = login.complete(callback);
  login.cancel();
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) {
    assert.equal(cancelled.error.code, "cancelled");
  }
});
type ResultNumber = ReturnType<typeof ok<number>>;

test("device wait deduplicates polling and resolves pending authorization", async () => {
  let calls = 0;
  const login = createDeviceSession({
    url,
    expiresInSeconds: 2,
    intervalSeconds: 0.001,
    poll: async () => (++calls === 1 ? { pending: true as const } : ok("credentials")),
  });
  const first = login.wait();
  assert.equal(first, login.wait());
  assert.deepEqual(await first, ok("credentials"));
  assert.equal(calls, 2);
  login.cancel();
});

test("device slow_down delays repolling until expiry, and cancel interrupts sleep", async () => {
  let calls = 0;
  const login = createDeviceSession({
    url,
    expiresInSeconds: 0.03,
    intervalSeconds: 0.001,
    poll: async () => {
      calls++;
      return { pending: true, slowDown: true };
    },
  });
  const result = await login.wait();
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "auth-expired");
  }
  const cancelledLogin = createDeviceSession({
    url,
    expiresInSeconds: 60,
    poll: async () => ok(1),
  });
  const waiting = cancelledLogin.wait();
  cancelledLogin.cancel();
  const cancelled = await waiting;
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) {
    assert.equal(cancelled.error.code, "cancelled");
  }
});

test("concurrent OAuth completion shares one exchange", async () => {
  let exchanges = 0;
  const login = createOAuthSession({
    url,
    redirectURI,
    state: "expected",
    exchange: async () => {
      exchanges++;
      return ok(1);
    },
  });
  const first = login.complete(callback);
  assert.equal(login.complete(callback), first);
  assert.deepEqual(await first, ok(1));
  assert.equal(exchanges, 1);
  assert.equal((await login.complete(callback.replace("secret", "different"))).ok, false);
});
