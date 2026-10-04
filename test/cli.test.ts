import assert from "node:assert/strict";
import test from "node:test";
import { main, parseArgs } from "../src/cli.js";

test("CLI uses a stable default origin and validates port options", () => {
  assert.deepEqual(parseArgs([]), { port: 4317, open: true, showHelp: false });
  assert.deepEqual(parseArgs(["--port", "65535", "--no-open"]), {
    port: 65535,
    open: false,
    showHelp: false,
  });
  assert.equal(parseArgs(["--help"]).showHelp, true);
  for (const value of ["0", "65536", "1.5", "-1", "NaN", "1e3", ""]) {
    assert.throws(() => parseArgs(["--port", value]), /--port requires/);
  }
  assert.throws(() => parseArgs(["--port"]), /--port requires/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option/);
});

test("CLI help works without loading the bundled demo", async () => {
  await main(["--help"]);
});
