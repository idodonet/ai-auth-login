# Compatibility and verification

Reference: [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) commit
`d318bcc3afb9ea8782862f5e8cdb541afdc9dfa5`.
This is a TypeScript port of provider behavior, not a wrapper launching its Go
server. Go plugins are not loaded. Model catalog availability does not guarantee
that a given account can use every listed model.

| Provider                     | Connection                       | Model discovery | SDK routes                                                | Numeric quota |
| ---------------------------- | -------------------------------- | --------------- | --------------------------------------------------------- | ------------- |
| Codex                        | Callback, device, API key        | Live            | Chat, Responses/compact/WebSocket, image generation/edits | Implemented   |
| Claude                       | Callback, API key                | Catalog         | Chat, Responses/compact, native Messages/count            | OAuth         |
| Antigravity                  | Callback                         | Live            | Chat, Responses/compact, native GenerateContent           | Implemented   |
| Kimi / Kimi AI               | Device, API key                  | Catalog         | Chat, Responses, native Messages/count                    | Implemented   |
| xAI                          | Device, API key                  | Catalog         | Chat, Responses/compact/WebSocket, speech, images, videos | OAuth billing |
| Devin                        | Browser/manual callback, API key | Catalog         | Chat, Responses                                           | Implemented   |
| Meta                         | Device, API key                  | Catalog         | Chat, Responses                                           | Device login  |
| Gemini / Gemini Interactions | API key                          | Live            | Chat, Responses, native GenerateContent/Interactions      | Unsupported   |
| Vertex                       | Service account, API key         | Catalog         | Chat, Responses, native GenerateContent                   | Unsupported   |
| AI Studio                    | Owned browser WebSocket relay    | Live            | Chat, Responses, native GenerateContent                   | Unsupported   |
| OpenAI-compatible            | API key and base URL             | Live            | Native HTTP passthrough                                   | Unsupported   |

All rows expose `models`. Responses on non-Responses providers use protocol
translation, not native OpenAI server-side storage. The generic adapter passes
through any SDK HTTP route; the upstream server determines actual support.
A descriptor is a route capability, not a claim that every operation within that
SDK namespace is implemented.

## Boundaries

Translated providers target text generation, streaming, tools, and the supported
multimodal fields, including embedded files, audio, video, and image content.
Generated images are mapped to Responses `image_generation_call` output items
where the provider produces image results. Normal reasoning streaming and Chat/Responses signed-thinking replay are covered
by local checks, including Gemini tool thought signatures and opaque native
OpenAI reasoning items. Translated Responses preserve native thinking blocks in
package continuation capsules; replay summaries alone never manufactures signed
thinking. Claude adaptive effort follows the referenced model catalog; older
models retain budget-based thinking.
Anthropic `json_object` uses a prompt instruction without a native JSON
guarantee; JSON-schema output is native. Gemini strict tools use VALIDATED
mode; embedded audio, file, and video content are supported. Gemini
`parallel_tool_calls: false`, Interactions strict tool schemas, and unresolved
`file_id` inputs remain explicit translation gaps. Stateful Responses retrieval/deletion, background jobs,
Realtime audio sessions, fine-tuning, file/vector-store management,
batches, and other media operations are not inferred from a Chat or Responses
capability. Unsupported translated routes fail explicitly rather than silently
calling an unrelated endpoint. Codex image generation/edits, xAI image
generation/edits and video creation/retrieval/download, and generic native HTTP
passthrough are separate implemented paths. xAI also accepts native video
extension/edit routes; these are provider-specific HTTP operations rather than
a guarantee that every OpenAI video operation is available.

`countTokens()` is implemented for every built-in provider. Claude/Kimi use the
native Messages token-count endpoint; Gemini/Interactions, Vertex, Antigravity
and AI Studio use native Gemini counting. Codex, xAI, Meta, Devin and generic
OpenAI-compatible connections use an explicitly marked local BPE estimate.
Estimates exclude media tokens and protocol overhead. Gemini counts containing
system instructions/tools use the documented
[`generateContentRequest`](https://ai.google.dev/api/tokens) envelope.

Native provider routes preserve provider JSON: Claude/Kimi Messages and
Messages/count_tokens; Gemini, Vertex, Antigravity and AI Studio
GenerateContent/StreamGenerateContent/CountTokens; Gemini Interactions uses
`/v1beta/interactions`. These native entry points are provider-specific, not a
universal conversion of every native protocol into every other provider.

Claude/Antigravity compact summarizes history into a CPA-compatible continuation
capsule; it preserves tool history and prevents the summary turn from calling
tools. It can lose detail as any summary can. Its fixed CPA encryption key is
wire encoding, not a confidentiality or authorization boundary. Explicit compact
is non-stream; a Responses `compaction_trigger` can return streamed completion
events. Codex/xAI compact is native upstream passthrough. xAI speech maps SDK
voices/formats to native TTS and preserves binary audio. Both xAI compact and
speech use the official API, including OAuth connections.

`openResponsesSocket()` connects native Responses events for Codex/xAI. The
session owns cancellation and closes sockets on logout, account replacement and
close; it does not implement Realtime audio, automatic reconnect or HTTP fallback.
Callers supply native `response.create` payloads and handle WebSocket events.

Quota endpoints and payloads were compared with
[CLI Proxy's management center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/tree/c9e2f7cb0b065c13211285d9525bcc8761f17837/src/features/quota/providers).
Antigravity uses `retrieveUserQuotaSummary` with its project and fixed endpoint
fallbacks. Claude OAuth uses `/api/oauth/usage`. xAI OAuth reads weekly and monthly
CLI billing, including product usage and on-demand/prepaid balances. Kimi uses
the appropriate `.com` or `.ai` coding `/v1/usages`; Meta device login reads
`subs_usage` using its DCA token. Codex reads WHAM usage and credit balance;
Devin reads its native status response.

`supported` depends on credentials as well as the provider. Codex, Claude, xAI
API keys and Meta without a DCA token lack these subscription quota endpoints.
Unknown values remain `null`, and exhausted quota remains zero. Monetary
windows use `usd-cents`; quota checks do not run inference. xAI's paid-key
health probe in the reference is a chat request, not a numeric quota report.
Gemini API-key, Vertex, and AI Studio account quota adapters are absent from
the reference; Gemini models through Antigravity use Antigravity quota.
Provider descriptors advertise available quota implementations, not access
for every credential type. These endpoints were fixture-tested; live quota
access still depends on provider/account permissions.

AI Studio needs a browser signed into AI Studio and an owned loopback WebSocket
listener. Its browser helper performs requests in that browser context. Browser
cookies never become exported package state. A restored relay state requires
starting/reconnecting the relay and browser; state alone is not a persistent
Google browser login.

## Evidence levels

Local checks cover typed declarations, fixture-based auth and protocol behavior,
stream framing/cancellation, isolated SDK credentials, lifecycle cleanup, and
local relay/native passthrough behavior. Live provider authentication, live quota
availability, current provider policy and browser CORS behavior require real
accounts and are not established by those checks. Neither an npm tarball nor a
passing fixture test constitutes production acceptance.

The package is prepared for local installation and review. It is not published
by this work. Provider endpoints and catalogs may evolve independently of this
public API and should be checked when updating the pinned upstream reference.

## Authentication validation

`checkAuth()` refreshes credentials and uses provider checks where implemented.
Vertex and Meta API-key checks currently validate configuration structurally;
they do not prove that the remote service accepts the key. Service-account
validation/token exchange also does not prove project-level model permissions.
Only a successful live model request establishes that account's access.
