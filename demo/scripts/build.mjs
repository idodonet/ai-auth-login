import { rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const npm = process.env.npm_execpath;
if (!npm) {
  throw new Error("Run this script through npm.");
}
execFileSync(process.execPath, [npm, "run", "build"], {
  cwd: new URL("../..", import.meta.url),
  stdio: "inherit",
});
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [npm, "run", "check"], { stdio: "inherit" });
execFileSync(process.execPath, [npm, "exec", "--", "tsc", "-p", "tsconfig.server.json"], {
  stdio: "inherit",
});
execFileSync(process.execPath, [npm, "exec", "--", "vite", "build"], {
  stdio: "inherit",
});
