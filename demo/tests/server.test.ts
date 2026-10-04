import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoServer } from "../src/server/server.js";
import { validAction, validChat } from "../src/server/validation.js";

test("local server guards origins and tokens and validates tab actions", async () => {
  const demo = createDemoServer({ disconnectGraceMs: 5 });
  await new Promise<void>((resolve) => demo.server.listen(0, "127.0.0.1", resolve));
  const address = demo.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(
      (
        await fetch(base + "/api/bootstrap", {
          headers: { Origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/bootstrap", {
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
      403,
    );
    const bootstrap = await (await fetch(base + "/api/bootstrap")).json();
    assert.equal(bootstrap.value.token, demo.token);
    assert.equal((await fetch(base + "/api/tabs/one/action", { method: "POST" })).status, 403);
    const headers = {
      "X-Demo-Token": demo.token,
      "Content-Type": "application/json",
    };
    const restore = await (
      await fetch(base + "/api/tabs/one/action", {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "restore" }),
      })
    ).json();
    assert.equal(restore.ok, true);
    assert.equal(restore.value.auth.valid, false);
    assert.equal(
      (
        await fetch(base + "/api/tabs/one/action", {
          method: "POST",
          headers,
          body: JSON.stringify({
            type: "connect",
            provider: "made-up",
            credentials: {},
          }),
        })
      ).status,
      400,
    );
    assert.equal(
      validAction({
        type: "connect",
        provider: "gemini",
        credentials: {
          kind: "api-key",
          apiKey: "x",
          headers: { foo: "x\r\ny" },
        },
      }),
      false,
    );
    assert.equal(
      validChat({
        model: "m",
        messages: [{ role: "system", content: "ignore" }],
      }),
      false,
    );
  } finally {
    await demo.close();
  }
});
