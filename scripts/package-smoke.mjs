import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const rootManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const tarball =
  process.argv[2] ??
  fileURLToPath(
    new URL(
      `../${rootManifest.name.replace(/^@/, "").replace(/\//g, "-")}-${rootManifest.version}.tgz`,
      import.meta.url,
    ),
  );
const archive = resolve(tarball);
const files = (await run("tar", ["-tzf", archive])).stdout.trim().split("\n");
for (const required of [
  "README.md",
  "docs/images/demo.png",
  "dist/cli.js",
  "dist/index.js",
  "dist/demo/server/server.js",
  "dist/demo/client/index.html",
]) {
  assert.ok(files.includes(`package/${required}`), `Missing packed ${required}`);
}
assert.ok(
  files.some((file) => /^package\/dist\/demo\/client\/assets\/.+\.js$/.test(file)),
  "Missing bundled browser assets",
);
assert.ok(
  !files.some((file) =>
    /(?:^|\/)(?:node_modules|dist-test|\.env(?:\..*)?|\.github)(?:\/|$)/.test(file),
  ),
  "Unexpected private/development files in package",
);
assert.ok(
  !files.some((file) => /^package\/(?:demo|src|test|scripts)\//.test(file)),
  "Source or harness included in published package",
);
const directory = await mkdtemp(join(tmpdir(), "ai-auth-login-package-"));
let child;
try {
  await writeFile(join(directory, "package.json"), '{"private":true,"type":"module"}\n');
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], {
    cwd: directory,
    timeout: 120_000,
  });
  const installed = join(directory, "node_modules", "ai-auth-login");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.bin?.["ai-auth-login"]?.replace(/^\.\//, ""), "dist/cli.js");
  assert.ok(
    !Object.values(manifest.dependencies ?? {}).some((value) => String(value).startsWith("file:")),
    "Production dependency points outside package",
  );
  const executable = join(installed, "dist", "cli.js");
  assert.match(await readFile(executable, "utf8"), /^#!\/usr\/bin\/env node\r?\n/);
  if (process.platform !== "win32") {
    assert.ok((await stat(executable)).mode & 0o111, "CLI is not executable");
  }
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import assert from "node:assert/strict"; import { ProviderSession } from "ai-auth-login"; assert.equal(ProviderSession.listProviders().length, 13); const session = new ProviderSession(); await session.close();',
    ],
    { cwd: directory, timeout: 5000 },
  );
  const help = await run("npm", ["exec", "--offline", "--", "ai-auth-login", "--help"], {
    cwd: directory,
    timeout: 10_000,
  });
  assert.match(help.stdout, /--port/);
  assert.match(help.stdout, /--no-open/);
  await assert.rejects(
    run("npm", ["exec", "--offline", "--", "ai-auth-login", "--port", "invalid"], {
      cwd: directory,
      timeout: 10_000,
    }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /port/i);
      return true;
    },
  );

  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  child = spawn(
    "npm",
    ["exec", "--offline", "--", "ai-auth-login", "--no-open", "--port", String(port)],
    {
      cwd: directory,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = once(child, "exit");
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`CLI exited before listening: ${output}`);
    }
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(500) });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.ok(response, `CLI did not start: ${output}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html/);
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)].map(
    (match) => match[1],
  );
  assert.ok(
    assets.some((asset) => asset.endsWith(".js")),
    "HTML has no built JavaScript",
  );
  for (const asset of assets) {
    const fetched = await fetch(new URL(asset, url));
    assert.equal(fetched.status, 200, `Bundled asset failed: ${asset}`);
    assert.ok((await fetched.text()).length > 0);
  }
  const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.value.providers.length, 13);
  await assert.rejects(
    run("npm", ["exec", "--offline", "--", "ai-auth-login", "--no-open", "--port", String(port)], {
      cwd: directory,
      timeout: 10_000,
    }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /in use|EADDRINUSE/i);
      return true;
    },
  );
  assert.match(output, new RegExp(`(?:127\\.0\\.0\\.1|localhost):${port}`));
  if (process.platform === "win32") {
    child.kill("SIGTERM");
  } else {
    process.kill(-child.pid, "SIGTERM");
  }
  const [code, signal] = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("CLI did not shut down after SIGTERM")), 5000).unref(),
    ),
  ]);
  assert.ok(code === 0 || signal === "SIGTERM", `Unexpected shutdown ${code}/${signal}: ${output}`);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(500) }));
  child = undefined;
  console.log(
    "Package smoke passed: fresh install, offline CLI, SDK import, bundled HTTP assets, providers, SIGTERM cleanup.",
  );
} finally {
  if (child && child.exitCode === null) {
    try {
      if (process.platform === "win32") {
        child.kill("SIGKILL");
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {}
  }
  await rm(directory, { recursive: true, force: true });
}
