# ADR-0338 — LLM surface/transport metadata, Anthropic codec SSOT, and OpenAI cache/checkpoint seams

## Status

Accepted (2026-05-27).

## Related

- ADR-0139 — enterprise Anthropic transport fork (`default` / `bedrock` /
  `vertex`).
- ADR-0151 — Bedrock/Vertex real-stream graduation.
- ADR-0172 — Foundry real-stream graduation.
- ADR-0322 — cache-control thread-stability audit.
- ADR-0337 — image-retry wm-live snapshot (same default-OFF seam discipline).

## Context

The repo had three distinct concerns entangled in one loose "provider" idea:

1. **Vendor/auth badge** — what the user sees (`anthropic`, `openai`,
   `chatgpt-oauth`, auth-mode text).
2. **Wire surface** — Anthropic Messages vs OpenAI Chat Completions vs OpenAI
   Responses.
3. **Transport** — public API vs Bedrock vs Vertex vs Foundry vs Mantle vs
   ChatGPT OAuth.

The public Anthropic path already had the canonical request shaping:

- system block → `cache_control` mapping
- conversation-prefix cache breakpoint placement
- multimodal image/document shaping
- thinking carry-over shaping
- tool-result structured content shaping

But the enterprise Anthropic transports (`bedrock`, `vertex`, `foundry`)
built request bodies manually and passed raw `input.system` / raw
`message.content` directly into `messages.create()`. That created a drift seam:
public Anthropic and enterprise Anthropic could diverge on cache markers,
multimodal handling, and future Messages-shape updates.

Separately, OpenAI paths had no canonical slot for:

- prompt-cache routing hints (`prompt_cache_key`, optional retention)
- terminal response-id checkpoints from Responses surfaces
- route metadata on `llm_request` telemetry

## Decision

### 1. Keep core correctness on full logical transcripts

`StreamInput.messages` remains the source of truth. The agent loop still builds
full logical transcripts per turn. No adapter is allowed to replace this with
provider-local hidden state.

`previous_response_id` resume is allowed only as an adapter-local,
fail-closed optimization on a surface that can prove strict-extension safety
against the **shaped** wire request, not just the pre-wire transcript.

### 2. Add explicit wire-route metadata to `LLMPort`

`LLMPort` grows two optional fields:

- `surfaceId`
- `transportId`

They are orthogonal to the pre-existing `provider` and `authMode` fields.

Phase-1 posture:

- `provider` remains the legacy user-facing/vendor-auth badge.
- `surfaceId` identifies the grammar.
- `transportId` identifies the route.

This avoids a large cross-repo rename while giving telemetry enough structure
to distinguish:

- `anthropic + anthropic-messages + public`
- `anthropic + anthropic-messages + bedrock`
- `chatgpt-oauth + openai-responses + chatgpt-oauth`
- `openai + openai-chat-completions + public`
- `openai + openai-responses + public`

Wrappers (`RetryingLLM`, `FallbackLLM`, replay/recording, image-sanitize retry,
failure counter) forward these fields verbatim from the wrapped port.

`llm_request` AgentEvents and JSONL recorder lines also carry these optional
route fields when present.

Responses continuation decisions additionally surface as a closed
`llm_continuation` observation event. The LLM layer emits the authoritative
decision as a `StreamEvent`; the loop projects it onto AgentEvent so JSONL,
stdout, debug tracer, timeline, and turn-summary all see the same wire truth.

### 3. Promote one shared Anthropic Messages request builder

New file:

- `src/llm/anthropic-messages-codec.ts`

It becomes the single request-shaping source for Anthropic Messages:

- `toAnthropicSystem`
- `cacheConversationPrefix`
- `toAnthropicMessages`
- `toAnthropicToolChoice`
- `buildAnthropicMessagesRequest`

`AnthropicAdapter`, `BedrockProviderAdapter`, `VertexProviderAdapter`, and
`FoundryProviderAdapter` now all call `buildAnthropicMessagesRequest(...)`
before opening `client.messages.create(...)`.

Result:

- one cache-marker policy
- one multimodal/document policy
- one thinking/tool_result serialization policy
- one tool_choice validation path

This closes the enterprise/public drift seam without changing the stream-event
decoder (`mapRawEvent` stays shared exactly as before).

### 4. Add prompt-cache routing fields to `StreamInput`

`StreamInput` gains:

- `promptCacheKey?: string`
- `promptCacheRetention?: "in-memory" | "24h"`

Compatible OpenAI surfaces forward them on the wire:

- Chat Completions: `prompt_cache_key`, `prompt_cache_retention`
- Responses: `prompt_cache_key`, `prompt_cache_retention`

Anthropic surfaces ignore them.

Phase-1 production hookup:

- main agent loop: `promptCacheKey = sessionId` when present and non-empty
- side conversation runner: `promptCacheKey = parentSessionId`

This deliberately chooses the existing session/thread identity instead of
inventing a second routing id.

OpenAI `surface:auto` now resolves by route:

- official OpenAI API (`api.openai.com`, explicit or implicit) → `responses`
- custom OpenAI-compatible `baseURL` → `chat-completions`

This keeps the richer official OpenAI surface as the default while preserving
compatibility with third-party OpenAI-compatible servers that only implement
Chat Completions.

### 5. Add a Responses checkpoint seam and BYOK resume path

`StreamInput` gains:

- `onCheckpoint?: (checkpoint) => void`

New checkpoint type:

- `ResponsesCheckpoint`

Current producers:

- `ChatGPTOAuthAdapter` emits a checkpoint when `response.completed` carries a
  non-empty `response.id`.
- `OpenAIResponsesAdapter` emits the same checkpoint and uses a session-owned
  in-memory continuation store when strict-extension proof succeeds.

The authoritative owner of that store is the session execution plane /
surface composition root. Adapters may read/write the store for their own
surface-local optimization, but they do not own the store's lifetime.

`openai-responses` and `chatgpt-oauth` both route through one shared
Responses surface stream helper for:

- request-sent timing on the real POST boundary
- first-chunk / idle stream timeouts
- `response.completed` checkpoint emission
- resumability classification from normalized output items / reasoning events
- one-shot stale-`previous_response_id` self-heal on retryable HTTP failures

`chatgpt-oauth` now also participates in automatic resume when the session
execution plane wires a continuation store. Unlike direct OpenAI BYOK, the
OAuth route additionally tracks route-level resume capability:

- `404` / `409` stale-state failures clear the entry and allow later resume
  attempts after a fresh full response
- `400` / `422` resume rejections clear the entry, retry once with the full
  shaped request, and permanently disable resume for that route for the rest
  of the session

This keeps `chatgpt-oauth` fail-closed when the backend rejects
`previous_response_id` semantics while still letting parity-compatible routes
benefit from delta resume.

Checkpoint payload includes:

- `type: "openai-responses"`
- `model`
- `surfaceId`
- `transportId`
- `responseId`
- optional `promptCacheKey`
- optional `promptCacheRetention`

The callback is **best-effort**. Adapter swallows callback failures the same
way `onChunk` is swallowed.

Automatic resume posture:

- enabled on:
  - `openai + openai-responses + public`
  - `chatgpt-oauth + openai-responses + chatgpt-oauth`
- keyed by `promptCacheKey`
- guarded by request-fingerprint equality on all non-input fields
- guarded by `baseline = previous_input_items + normalized_output_items`
- guarded by strict-extension tail extraction
- forced FULL fallback on any mismatch, unsupported output item, or reasoning
  activity
- if a resumed request hits a retryable stale-state HTTP failure (`400` / `404`
  / `409` / `422`), clear that lane entry and retry ONCE with the full shaped
  input
- `chatgpt-oauth` additionally marks the route non-resumable for the rest of
  the session when that first failed resumed call returns `400` or `422`

Reasoning is treated as non-resumable when either:

- a reasoning delta event is observed, or
- `usage.output_tokens_details.reasoning_tokens > 0`

This keeps hidden server-side reasoning state from silently carrying across a
turn where the full-transcript path would not reproduce it.

## Non-goals

- No WebSocket transport work.
- No attempt to unify the legacy `provider` string taxonomy yet.
- No persistence policy for the new checkpoint objects/store. Session-owned,
  in-memory only.

## Implementation

Code changes landed with this ADR:

- `src/llm/target-metadata.ts`
- `src/llm/anthropic-messages-codec.ts`
- `src/llm/openai-responses-wire.ts`
- `src/llm/responses-continuation-store.ts`
- `src/llm/responses-continuation-wrapping.ts`
- `src/llm/responses-stream.ts`
- `src/llm/adapters/anthropic.ts`
- `src/llm/providers/{default,bedrock,vertex,foundry,mantle}-adapter.ts`
- `src/llm/adapters/{openai,openai-responses,chatgpt-oauth}.ts`
- `src/llm/{types,ports,index}.ts`
- `src/llm/factory.ts`
- wrapper forwards in retry/fallback/replay/recording/image-sanitize/failure-counter
- `src/agent/loop.ts`
- `src/agent/side-conversation/run.ts`
- `src/runner/session-execution-plane.ts`
- `src/host/runtime/internal/context-binding.ts`
- `src/apps/cli/repl.ts`
- `src/apps/cli/repl/{runtime-context-compose,session-setup}.ts`
- `src/apps/cli/{debug-tracer,timeline-panel,turn-summary}.ts`
- `src/apps/headless/session-bridge.ts`
- `src/stream/{types,adapters/jsonl-recorder.ts}`
- replay exact-hash update in `src/llm/replay/jsonl-store.ts`

## Tests

New / expanded proof rails:

- `tests/unit/llm/openai-prompt-cache.test.ts`
  - Chat Completions forwards `prompt_cache_key` and retention.
- `tests/unit/llm/openai-responses-wire.test.ts`
  - Responses input shaping preserves item order.
  - strict-extension diff is pinned.
  - unsupported output items fail closed.
- `tests/unit/llm/openai-responses-adapter.test.ts`
  - BYOK Responses uses `previous_response_id` only on strict extension.
  - reasoning activity forces full fallback.
  - stale `previous_response_id` self-heals with one full-input retry.
- `tests/unit/llm/factory-openai-surface.test.ts`
  - OpenAI auto surface resolves to Responses on the official API.
  - Custom OpenAI-compatible base URLs stay on Chat Completions.
- `tests/unit/auth/chatgpt-oauth-adapter.test.ts`
  - Responses body forwards prompt-cache fields.
  - `response.completed` with response id emits a checkpoint.
  - strict-extension resume uses `previous_response_id` with delta-only input.
  - `404` stale-state failures self-heal without disabling future resume.
  - `400`/`422` resume rejections permanently disable resume for that route.
- `tests/unit/llm/responses-continuation-store.test.ts`
  - route-level resume disable persists across entry clear and resets on
    `clearAll()`.
- `tests/unit/llm-providers/bedrock-adapter-hellgate.test.ts`
  - Bedrock request shaping reuses canonical Anthropic builder.
- `tests/unit/jsonl-recorder.test.ts`
  - `llm_request` preserves optional route metadata when present.
  - `llm_continuation` rides the llm span and records closed fallback reasons.
- `tests/unit/stream/plan-events-hell.test.ts`
  - AgentEvent drift gate includes `llm_continuation`.
- `tests/unit/cli/debug-tracer-hellgate.test.ts`
  - tracer renders `llm_continuation` mode/reason/status.
- `tests/unit/cli/turn-summary.test.ts`
  - turn summary folds resume/retry/disable continuation outcomes.
- `tests/unit/llm/responses-continuation-wrapping.test.ts`
  - execution-plane store injection preserves route metadata and never
    overwrites an explicit caller store.

Existing Anthropic cache / cache-control hellgates continue to pin the shared
builder because `AnthropicAdapter` now delegates to that same source.

## Follow-up

1. Add an optional persistent, lane-scoped continuation sink/reader if
   process-restart resume becomes worth the complexity.
2. Replace the legacy `provider` badge with an explicit vendor axis when the
   surrounding surface/UI contracts can absorb that rename cleanly.
