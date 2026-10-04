# AI Auth Login demo

A local React client with a small Node server that calls the SDK directly. The packaged demo requires Node.js 22 or newer; building from source requires Node.js 22.14 or newer (Node.js 24 is used in CI). Run development commands from `demo/` unless specified.

## Development

Install the SDK dependencies in the repository root with `npm ci`, then:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:4317. Vite forwards `/api` to the Node server on port 4318. Both ports are fixed; free them before starting. The server binds to loopback. The bootstrap response provides a per-process API token; subsequent requests send it as `X-Demo-Token`.

```sh
npm run build
npm run check
npm test
npm start
```

Build once before running checks or tests on a fresh checkout so the linked SDK exports exist. The production server serves `dist/client` on http://127.0.0.1:4317. `npm run build` also builds the SDK. Vite reloads browser changes automatically. Restart the demo after changing server or SDK source. The server runs without a watcher so SDK rebuilds cannot restart it midway through replacing compiled files.

## Sessions and credentials

The theme selector defaults to System and follows the OS appearance; Light and Dark override it. `theme.ts` stores this preference under a separate browser storage key, outside SDK saved state.

Each tab has its own SDK session and conversation. Browser local storage retains SDK saved state and messages, including authentication secrets. Use only a trusted local browser profile; logging out clears the session's saved credentials. Browser clearing or demo storage removal clears persisted tabs. Provider login pages run in the browser; callback authentication requires pasting the complete returned callback URL. Device authentication waits for authorization after the displayed code is entered.

API keys and service account JSON are sent to the local server. AI Studio relay connection details can contain a bearer token. Do not share browser storage exports or relay tokens. This demo is a local tool; do not expose its server on a public network.

## Run the packaged demo

The SDK and demo ship in one npm package. Once the first npm release has been published:

```sh
npx ai-auth-login
```

The command launches the bundled local server and opens the browser. It needs no source checkout or build tooling. The CLI's `--help` lists launch options. This checkout has not been published yet; use the local package commands below until CI and npm trusted publishing are configured.

From the repository root, install both sets of development dependencies and create the package:

```sh
npm ci
npm ci --prefix demo
npm pack
npm run test:package
```

`npm pack` runs the full demo build and includes the SDK, CLI, server, and browser assets under `dist/`. `npm run test:package` installs that tarball into an isolated temporary directory and checks the packaged executable. To try the same tarball manually, use its absolute path from another directory:

```sh
npm exec --yes --package=/absolute/path/ai-auth-login-0.1.0.tgz -- ai-auth-login
```

The private `demo/package.json` organizes source development only. There is no separately published demo package. See the [release guide](releasing.md) for CI publishing setup.

## Local upstream smoke check

Run `npm run test:upstream` in a second terminal. Connect an OpenAI-compatible tab with base URL `http://127.0.0.1:4319/v1` and API key `demo-key`. Choose `demo-chat` for streaming success or `demo-error` to exercise an upstream error. This synthetic fixture checks the local UI/API flow; it does not validate any live provider credentials or quota.

## Source guide

Paths below are relative to `demo/` in the source checkout.

- `src/client/App.tsx` owns tab selection, session snapshots, conversation state, and persistence. `main.tsx` mounts the app.
- `SessionTabs.tsx` switches and closes tabs. `ConnectionPanel.tsx` handles provider credentials, and callback/device login. `RelayApp` in `App.tsx` handles the AI Studio relay helper. `AccountPanel.tsx` displays account, quota, and session statistics; `App.tsx` displays warnings. `ChatPanel.tsx` selects models and displays streamed messages.
- `src/client/api.ts` sends typed actions, reads session events, and parses chat streams. `storage.ts` validates browser storage while preserving SDK saved state as opaque text; `theme.ts` handles the separate appearance preference.
- `src/server/server.ts` serves browser assets and routes the guarded API. `validation.ts` validates incoming requests. `sessions.ts` keeps a separate SDK session and chat operation for each tab. `index.ts` starts the loopback server and closes it on shutdown.
- `src/shared/types.ts` defines the API and persistence contract; SDK types come directly from the package.

An action flows from a panel through `api.ts` to the tab's SDK session. SDK state changes become `state` events; refreshed account/model/session information becomes `session` events on the shared event stream. `App.tsx` applies those updates to the matching tab and saves browser state. Chat uses a separate NDJSON response: deltas update the assistant message until completion, cancellation, or error.
