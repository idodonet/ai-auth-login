import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/** Local acceptance fixture only; no real account or provider credentials. */
export function createTestUpstream({ delay = 100 } = {}) {
  return createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer demo-key") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid demo key" } }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: ["demo-chat", "demo-error"].map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "demo",
          })),
        }),
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body;
    try {
      let text = "";
      for await (const chunk of request) {
        text += chunk;
      }
      body = JSON.parse(text);
      if (!Array.isArray(body.messages) || !body.messages.length) {
        throw new Error();
      }
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Expected chat messages" } }));
      return;
    }
    if (body.model === "demo-error") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Demo rate limit",
            type: "rate_limit_error",
            code: "rate_limit",
          },
        }),
      );
      return;
    }
    const content =
      "Hello from the local demo upstream. Streaming works, and Stop can cancel this reply.";
    const base = { id: "demo-completion", created: 0, model: body.model };
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const text of content.match(/.{1,5}/g) ?? []) {
      if (response.destroyed) {
        return;
      }
      response.write(
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, body.model === "demo-slow" ? 250 : delay));
    }
    if (!response.destroyed) {
      response.end("data: [DONE]\n\n");
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createTestUpstream();
  server.listen(4319, "127.0.0.1", () =>
    console.log(
      "Local test upstream: http://127.0.0.1:4319/v1\nAPI key: demo-key\nModels: demo-chat, demo-error",
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close());
  }
}
