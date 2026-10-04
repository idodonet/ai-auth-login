# SDK reference

A TypeScript package that owns provider login state and returns an OpenAI SDK
client backed by an in-process transport. Requires Node.js 22 or newer.
The SDK transport opens no HTTP port. OAuth callback requirements and the
AI Studio WebSocket relay are separate provider-specific resources.

```ts
import { ProviderSession } from "ai-auth-login";

const session = new ProviderSession({ state: previouslySavedJSON });
session.onStateChange((state) => {
  // Persist this secret JSON string; null means remove the saved login.
  // Serialize asynchronous storage writes and handle their errors here.
  persistState(state);
});

const auth = await session.checkAuth();
if (!auth.ok) showError(auth.error.message);
else if (!auth.value.valid) {
  const started = await session.beginAuth("codex");
  if (!started.ok) showError(started.error.message);
  else {
    const login = started.value;
    openBrowser(login.url);
    const completed =
      login.kind === "callback"
        ? await login.complete(await askForCallbackURL())
        : await login.wait();
    if (!completed.ok) showError(completed.error.message);
  }
}

const created = await session.createSDK({ timeout: 60_000, maxRetries: 2 });
if (created.ok) {
  const models = await session.listModels();
  // sdk.models.list() uses the same discovery source; no separate SDK needed.
  if (models.ok && models.value[0]) {
    const answer = await created.value.responses.create({
      model: models.value[0].id,
      input: "Hello",
    });
    console.log(answer.output_text);
  }
}
await session.close();
```

`ProviderSession.listProviders()` describes every built-in provider's connection
methods, SDK endpoints, model discovery, and quota availability. Aliases
`kimi.com` and `kimi.ai` resolve to `kimi` and `kimi-ai` respectively.
See [the compatibility matrix](compatibility.md) before choosing a provider.

## API keys and other connections

```ts
await session.connect("gemini", { kind: "api-key", apiKey });
await session.connect("openai-compatibility", {
  kind: "api-key",
  apiKey,
  baseURL: "https://your-upstream.example/v1",
});
await session.connect("vertex", {
  kind: "service-account",
  serviceAccount: serviceAccountJSON,
  project: "your-project",
  location: "us-central1",
});
// Device login:
const device = await session.beginAuth("kimi", { method: "device" });
if (device.ok && device.value.kind === "device") {
  console.log(device.value.url, device.value.userCode);
  const completed = await device.value.wait();
}
```

Custom upstream configuration requires its own base URL; SDK URL and credentials
remain internally controlled. Generic OpenAI-compatible requests preserve the
SDK HTTP path, body, status, content type, multipart content, and streaming.
Endpoint availability still depends on the configured server.

## Persistence and lifecycle

State is opaque JSON **containing credentials**. Save it securely, without
parsing its private fields. Restoration validates state structure and version.
Unsupported state versions and malformed state require a new login; current
versions are encoded internally. Do not assume compatibility with CLIProxyAPI's
Go credential files. Successful login records its time; refresh does not replace
that time. Failed login keeps the previous account.

Package operations return `Result<T>` for expected failures, with safe messages,
error codes, and retryability. OpenAI SDK requests retain OpenAI's normal thrown
errors. Network failures during auth checking differ from invalid credentials.

`onStateChange()` returns an unsubscribe function for removing one listener while
the session remains open. `close()` removes every listener, cancels owned work,
and releases provider resources. It is idempotent and preserves saved state.
SDK clients created by a closed session cannot send further requests.
`logout()` clears the saved account and emits `null`. Storage work started by
listeners belongs to the application and must be awaited there.

`getAccount()` returns available account metadata or `null`. Unknown fields are
`null`. `getQuota()` returns explicit unsupported status when the provider has
no implemented numeric quota source. `resetsAt` is an ISO timestamp for local
countdowns. `getStats()` counts upstream SDK request attempts, including SDK retries and
resource operations such as video retrieval/download;
account, quota, and model discovery requests are excluded.

## AI Studio browser relay

```ts
// Node application:
const relay = await session.connect("aistudio", { kind: "relay" });
if (!relay.ok) throw new Error(relay.error.message);
const privateConnection = session.getConnection();
// Transfer this ephemeral secret only to your signed-in AI Studio browser.
```

```ts
// Bundle/run inside the signed-in https://aistudio.google.com browser context:
import { connectAIStudioBrowser } from "ai-auth-login/aistudio-browser";
const disconnect = connectAIStudioBrowser(privateConnection);
// Later, disconnect() releases browser resources; session.close() releases Node resources.
```

The connection token is private. Browser-side authentication and Google CORS
behavior require live verification. External relay URLs are not supported;
`connect({ kind: "relay" })` creates an owned loopback listener.

## Public API reference

```ts
new ProviderSession({ state?, fetch? });
ProviderSession.listProviders(): readonly ProviderDescriptor[];
session.provider: Provider | null;
session.checkAuth(): Promise<Result<AuthStatus>>;
session.beginAuth(provider, { method?: "callback" | "device" }): Promise<Result<AuthSession>>;
session.connect(provider, credentials): Promise<Result<void>>;
session.createSDK(options?): Promise<Result<OpenAI>>;
session.getAccount(): Promise<Result<Account | null>>;
session.getQuota(): Promise<Result<Quota>>;
session.listModels(): Promise<Result<readonly Model[]>>;
session.getStats(): SessionStats;
session.getConnection(): RelayConnection | null;
session.exportState(): SavedState | null;
session.onStateChange(listener): () => void;
session.logout(): Promise<void>;
session.close(): Promise<void>;
```

`Account.lastAuthenticatedAt` exposes successful login time without exposing
private state. Constructor `fetch` supplies the transport for auth, account,
quota, discovery, and model requests. A `createSDK({ fetch })` override applies
to that SDK's transport. Neither allows SDK base URL or auth replacement.
See compatibility notes for providers whose API-key validation is structural
rather than a remote credential check.

## Runnable examples

Build with `npm run build`, then use Node.js 22.18+ (or Node.js 24) to run TypeScript directly:

```sh
PROVIDER_STATE='your-saved-state-json' MODEL=your-model node examples/sdk.ts
node examples/basic.ts
```

Run these commands from the repository root. [sdk.ts](../examples/sdk.ts) restores saved state and sends a Responses request. [basic.ts](../examples/basic.ts) supports restored state, callback/device login, or an API-key upstream. It saves credentials to `AUTH_STATE_FILE` (default `.provider-state.json`) using restricted file permissions and serialized writes.
