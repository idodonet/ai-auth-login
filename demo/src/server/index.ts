import { createDemoServer } from "./server.js";

const port = Number(process.env.PORT ?? process.env.DEMO_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("DEMO_PORT must be a valid TCP port.");
}
const demo = createDemoServer({ port });
demo.server.listen(port, "127.0.0.1", () => console.log(`Demo: http://127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void demo.close().then(() => process.exit(0));
  });
}
