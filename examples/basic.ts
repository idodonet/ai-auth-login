import { ProviderSession } from "../dist/index.js";
import { readFile, writeFile, rm, rename } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const stateFile = process.env.AUTH_STATE_FILE ?? ".provider-state.json";
const state = await readFile(stateFile, "utf8").catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") {
    throw error;
  }
  return undefined;
});
const session = new ProviderSession({ state });
const input = createInterface({ input: stdin, output: stdout });
let storage = Promise.resolve();
let storageError: unknown;
session.onStateChange((next) => {
  storage = storage
    .then(async () => {
      if (next === null) {
        await rm(stateFile, { force: true });
      } else {
        const temporary = `${stateFile}.tmp`;
        await rm(temporary, { force: true });
        try {
          await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
          await rename(temporary, stateFile);
        } finally {
          await rm(temporary, { force: true });
        }
      }
    })
    .catch((error) => {
      storageError = error;
      console.error("Could not save login state:", error);
    });
});
try {
  if (process.env.UPSTREAM_API_KEY) {
    const connected = await session.connect("openai-compatibility", {
      kind: "api-key",
      apiKey: process.env.UPSTREAM_API_KEY,
      baseURL: process.env.UPSTREAM_BASE_URL,
    });
    if (!connected.ok) {
      throw new Error(connected.error.message);
    }
  } else {
    const checked = await session.checkAuth();
    if (!checked.ok) {
      throw new Error(checked.error.message);
    }
    if (!checked.value.valid) {
      const started = await session.beginAuth("codex");
      if (!started.ok) {
        throw new Error(started.error.message);
      }
      const login = started.value;
      console.log("Open in your browser:", login.url);
      if (login.kind === "device") {
        console.log("Code:", login.userCode);
      }
      const completed =
        login.kind === "callback"
          ? await login.complete(await input.question("Paste the full redirect URL: "))
          : await login.wait();
      if (!completed.ok) {
        throw new Error(completed.error.message);
      }
    }
  }
  const created = await session.createSDK();
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  console.log((await created.value.models.list()).data);
  console.log(await session.getAccount(), await session.getQuota());
} finally {
  input.close();
  await session.close();
  await storage;
  if (storageError) {
    throw storageError;
  }
}
