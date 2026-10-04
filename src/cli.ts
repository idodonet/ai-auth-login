#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";

const help = `Usage: ai-auth-login [--port <number>] [--no-open]

Launch the bundled browser demo at http://127.0.0.1:4317.
  --port <number>  Use a TCP port from 1 to 65535 (default: 4317)
  --no-open        Print the URL without opening a browser
  --help           Show this help
`;

export function parseArgs(args: string[]) {
  let port = 4317;
  let open = true;
  let showHelp = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
    } else if (arg === "--no-open") {
      open = false;
    } else if (arg === "--port") {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        throw new Error("--port requires an integer from 1 to 65535.");
      }
      port = Number(value);
    } else {
      throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
    }
  }
  return { port, open, showHelp };
}

function openBrowser(url: string) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore" });
  const failed = () => console.error(`Could not open a browser. Open ${url} manually.`);
  child.once("error", failed);
  child.once("exit", (code) => {
    if (code !== null && code !== 0) {
      failed();
    }
  });
  child.unref();
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.showHelp) {
    console.log(help);
    return;
  }
  const serverUrl = new URL("./demo/server/server.js", import.meta.url);
  const { createDemoServer } = (await import(serverUrl.href)) as {
    createDemoServer(options: { port: number }): {
      server: Server;
      close(): Promise<void>;
    };
  };
  const demo = createDemoServer({ port: options.port });
  try {
    await new Promise<void>((resolve, reject) => {
      demo.server.once("error", reject);
      demo.server.listen(options.port, "127.0.0.1", () => {
        demo.server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await demo.close();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        `Port ${options.port} is already in use. Stop the other demo or choose --port <number>.`,
      );
    }
    throw error;
  }
  let stopping = false;
  const shutdown = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    void demo.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const url = `http://127.0.0.1:${options.port}`;
  console.log(`Demo: ${url}`);
  if (options.open) {
    openBrowser(url);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
