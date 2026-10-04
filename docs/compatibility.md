# Compatibility and verification

Reference: [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) commit
`e2bff0107bb307337aaa19018ccddd55f64253d5`.
This is a TypeScript port of provider behavior, not a wrapper launching its Go
server. Go plugins are not loaded. Model catalog availability does not guarantee
that a given account can use every listed model.

| Provider                     | Connection                       | Model discovery | SDK routes                                                                          | Numeric quota |
| ---------------------------- | -------------------------------- | --------------- | ----------------------------------------------------------------------------------- | ------------- |
| Codex                        | Callback, device, API key        | Live            | Chat, Responses, Responses compact, image generation/edits                          | Implemented   |
| Claude                       | Callback, API key                | Catalog         | Chat, Responses                                                                     | Unsupported   |
| Antigravity                  | Callback                         | Live            | Chat, Responses                                                                     | Unsupported   |
| Kimi / Kimi AI               | Device, API key                  | Catalog         | Chat, Responses                                                                     | Unsupported   |
| xAI                          | Device, API key                  | Catalog         | Chat, Responses, image generation/edits, video create/retrieve/download/extend/edit | Unsupported   |
| Devin                        | Browser/manual callback, API key | Catalog         | Chat, Responses                                                                     | Implemented   |
| Meta                         | Device, API key                  | Catalog         | Chat, Responses                                                                     | Unsupported   |
| Gemini / Gemini Interactions | API key                          | Live            | Chat, Responses                                                                     | Unsupported   |
| Vertex                       | Service account, API key         | Catalog         | Chat, Responses                                                                     | Unsupported   |
| AI Studio                    | Owned browser WebSocket relay    | Live            | Chat, Responses                                                                     | Unsupported   |
| OpenAI-compatible            | API key and base URL             | Live            | Native HTTP passthrough                                                             | Unsupported   |

All rows expose `models`. Responses on non-Responses providers use protocol
translation, not native OpenAI server-side storage. The generic adapter passes
through any SDK HTTP route; the upstream server determines actual support.
A descriptor is a route capability, not a claim that every operation within that
SDK namespace is implemented.

## Boundaries

Translated providers target text generation, streaming, tools, and the supported
multimodal fields, including embedded files, audio, video, and image content.
Generated images are mapped to Responses `image_generation_call` output items
where the provider produces image results. Normal reasoning streaming and Chat
signed-thinking replay are covered by
local checks (including Gemini tool thought signatures). Responses reasoning
item replay and advanced provider reasoning-policy parity remain unsupported.
Anthropic `json_object` uses a prompt instruction without a native JSON
guarantee; JSON-schema output is native. Gemini strict tools use VALIDATED
mode; embedded audio, file, and video content are supported. Gemini
`parallel_tool_calls: false`, Interactions strict tool schemas, and unresolved
`file_id` inputs remain explicit translation gaps. Stateful Responses retrieval/deletion, background jobs,
Realtime/WebSocket OpenAI sessions, fine-tuning, file/vector-store management,
batches, and audio/image generation are not inferred from a Chat or Responses
capability. Unsupported translated routes fail explicitly rather than silently
calling an unrelated endpoint. Codex image generation/edits, xAI image
generation/edits and video creation/retrieval/download, and generic native HTTP
passthrough are separate implemented paths. xAI also accepts native video
extension/edit routes; these are provider-specific HTTP operations rather than
a guarantee that every OpenAI video operation is available.

Quota reporting reflects only an actual implemented upstream source; missing
email, plan, limits, or reset windows remain unknown. Claude headers or account
flags are not treated as a complete numeric quota report. Gemini/Vertex do not
invent account-level quota from model rate-limit metadata.

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
