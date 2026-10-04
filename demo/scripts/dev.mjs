import { spawn, execFileSync } from "node:child_process";

const npm = process.env.npm_execpath;
if (!npm) {
  throw new Error("Run this script through npm.");
}
execFileSync(process.execPath, [npm, "run", "build"], {
  cwd: new URL("../..", import.meta.url),
  stdio: "inherit",
});
const children = [
  spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server/index.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      DEMO_PORT: "4318",
      DEMO_ORIGIN: "http://127.0.0.1:4317",
    },
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit",
  }),
];
let stopping = false;
function stop(code) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => stop(code ?? 1));
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
