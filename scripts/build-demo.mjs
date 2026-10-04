import { execFileSync } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";

const npm = process.env.npm_execpath;
if (!npm) {
  throw new Error("Run this script through npm.");
}

execFileSync(process.execPath, [npm, "run", "build"], {
  cwd: new URL("../demo/", import.meta.url),
  stdio: "inherit",
});
await mkdir(new URL("../dist/demo/", import.meta.url), { recursive: true });
await cp(new URL("../demo/dist/", import.meta.url), new URL("../dist/demo/", import.meta.url), {
  recursive: true,
});
