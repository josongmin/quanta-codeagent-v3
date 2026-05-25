# ADR-0234: LLM provider adapter onChunk wire + fromSdkError 16-kind extension

- Status: Accepted
- Date: 2026-05-25
- Slot: 0232 occupied by sibling agent's `0232-git-directive-turn-collector-wire.md` (parallel-co-dev); 0233 occupied; 0234 next free (per ADR collision policy — newcomer renumbers, peer-deference).
- Related:
  - ADR-0214 (typed-error enum 11→16, Codex spec — defined the 5 new kinds but
    left adapter `fromSdkError` mapping as follow-up)
  - ADR-0217 (typed-error enum 16-kind routing — routes 16 kinds in the
    recovery router, assumed adapters could emit them)
  - ADR-0227 (spinner-stall detection — defined `onChunk` knob on
    `withStreamTimeout` but listed "Provider adapter wire (onChunk injection)"
    as Tier 2 deliberate_hold)
  - ADR-0200 (stream-idle-timeout — the hard-abort sibling of the soft
    spinner-stall signal)
- 슬롯: 0228 ~ 0231 occupied. 0232 next free.

## Context

Two adjacent slices shipped their PRIMITIVES but explicitly deferred their
PROVIDER-ADAPTER wires; this ADR closes both gaps as one batch because both
mutate the same six adapter files (Anthropic / OpenAI / ChatGPT-OAuth /
Bedrock / Vertex / Foundry) and a single PR avoids the merge churn of
touching the same files twice.

### Gap 1: ADR-0227 `onChunk` is wired into `withStreamTimeout` but no
adapter passes it through

`src/llm/stream-timeout.ts` exposes an optional `onChunk?: () => void`
callback. The decorator's `notifyChunkArrival` helper invokes it on every
yielded raw chunk (token / tool-use delta / SSE frame), with a try/catch
that swallows exceptions so a faulty surface detector never poisons the
producer.

The spinner-stall detector (`src/llm/spinner-stall/`) consumes that signal
to bump per-correlation `lastEventMs` — when a stream goes silent past
the configured 30s threshold, the detector emits a "still working…
[r]etry / [a]bort" soft signal BEFORE the 60s/120s hard idle abort.

But: ZERO adapters threaded `onChunk` into `withStreamTimeout`'s opts.
The spinner-stall detector therefore tick-counted from `start(now)` only
and never observed actual chunk arrival. The soft panel either never
fired (stream is actively yielding but detector thinks it's stalled) or
fired wrongly (stream finished but detector kept the entry alive). The
ADR-0227 catalog entry explicitly listed this as a Tier-2 deliberate_hold.

### Gap 2: ADR-0214 / ADR-0217 added 5 new `LLMErrorKind` arms but
`LLMError.fromSdkError` still emits only the original 11

ADR-0214 extended `LLMErrorKind` from 11 → 16:
- `context_window_exceeded` (Codex `ContextWindowExceeded`)
- `cyber_policy` (Codex `CyberPolicy`)
- `too_many_failed_attempts` (Codex `ResponseTooManyFailedAttempts`)
- `thread_rollback_failed` (Codex `ThreadRollbackFailed`)
- `sandbox_error` (Codex `SandboxError`)

The ROUTER-stage classifier (`src/shared/error-classifier.ts::classify(e)`)
runs a documented heuristic ladder that emits all 5 new kinds. But the
ADAPTER-stage classifier (`src/shared/errors.ts::LLMError.fromSdkError`)
was left at the 11 original kinds. The catalog entry for
`llm-error-taxonomy` documents this:

> The 5 Codex-spec arms are emitted only by the heuristic `classify(e)`
> today. Adapter `fromSdkError` was NOT extended in ADR-0214 — that's a
> follow-up.

Of the 5 new kinds, exactly **two** carry provider-side signals at the
adapter boundary:
- `context_window_exceeded` — Anthropic 400 `invalid_request_error` with
  "context length"/"prompt is too long" in the body; OpenAI 400 with
  `code === "context_length_exceeded"`; Bedrock/Vertex/Foundry surface
  comparable shapes.
- `cyber_policy` — Anthropic 400 `permission_error`; OpenAI 400 with
  "content policy"/"policy violation" in the body.

The other three are emitted by layers above the adapter and stay there:
- `too_many_failed_attempts` — by the retry layer's own budget counter.
- `thread_rollback_failed` — by the conversation-checkpoint rollback API.
- `sandbox_error` — by the host-side sandbox tool layer.

Without the adapter-boundary mapping the two emitable kinds, both kinds
ride on `bad_request` and the loop's reactive compaction never fires;
HITL never engages. The 16-kind union is structurally complete but
semantically half-wired.

## Decision

### Wire 1 — `onChunk` threaded through every chunk-yielding adapter

Add `onChunk?: () => void` to `src/llm/types.ts::StreamInput`. Threaded
end-to-end: loop → StreamInput → adapter → `withStreamTimeout` opts.
Default-OFF: absent ⇒ adapters omit the field on the wrapper opts via
exactOptional conditional spread (byte-identical to pre-feature).

Per-adapter wiring (one conditional-spread line each):
- `src/llm/adapters/anthropic.ts` — `withStreamTimeout` call
- `src/llm/adapters/openai.ts` — `withStreamTimeout` call
- `src/llm/providers/bedrock-adapter.ts` — `withStreamTimeout` call
- `src/llm/providers/vertex-adapter.ts` — `withStreamTimeout` call
- `src/llm/providers/foundry-adapter.ts` — `withStreamTimeout` call

The `src/llm/providers/default-adapter.ts` delegates to `AnthropicAdapter`,
so it inherits the wire for free (no change needed).

The `src/llm/adapters/chatgpt-oauth.ts` adapter is the outlier — it parses
raw SSE itself instead of wrapping with `withStreamTimeout`, so it carries
a local `notifyChunkArrival` helper with the same swallow-policy contract:
faulty hook ⇒ silent catch, stream survives. Hooks fire on EVERY SSE frame
(text deltas, tool deltas, completion, even unknown event types) so the
detector sees liveness regardless of which `response.*` event arrived.

The `src/llm/providers/mantle-adapter.ts` is a Phase 1 throw-stub
(`stream()` throws `provider-unsupported` before yielding any chunk), so
there's no chunk-arrival surface to wire — explicitly skipped.

### Wire 2 — `fromSdkError` emits `context_window_exceeded` + `cyber_policy`

Extend the private `classify(status, e, msg)` helper in
`src/shared/errors.ts` to subdivide the 400/422 status branch. New
private helpers:
- `ADAPTER_CONTEXT_WINDOW_MARKERS` / `ADAPTER_POLICY_MARKERS` — narrow
  marker arrays (lowercased substrings).
- `lowerMessage(e)` — safe-on-circular message extraction (mirrors
  `error-classifier.ts::safeLower`; reads `.message` directly rather
  than stringifying the whole object).
- `lowerProviderCode(e)` — extracts `.error.type` / `.code` / `.type`
  (lowercased).
- `classifyBadRequest(e)` — runs the heuristic ladder
  (cyber_policy > context_window_exceeded > bad_request) for the
  400/422 status branch. Extracted to keep `classify`'s cyclomatic
  complexity at 16 (unchanged from baseline — was already at biome's
  effective allowance).

Precedence: a refusal that ALSO mentions "context length" routes to
`cyber_policy` (HITL) — NEVER to `context_window_exceeded` (reactive
compaction). The user must resolve the policy block first.

#### Why allow message-pattern matching at the adapter boundary?

The codebase otherwise bans `e.message.includes(...)` for error
classification. The ban targets DOWNSTREAM code (retry / fallback / loop)
that re-parses an already-wrapped LLMError's `.message` to recover
meaning the boundary already lost. The ADAPTER BOUNDARY is the
designated place where provider-specific shape leak is allowed — and
context_window_exceeded / cyber_policy DO arrive as message-bearing
400/422s with no SDK-union-typed alternative.

Three guards keep this safe:
1. Markers only fire on status 400/422 — a brand-new `unknown` arm
   (the most expensive misclassification) CANNOT regress.
2. Markers are narrow — pinned by an explicit hellgate; adding one
   without a positive test is forbidden.
3. Empty / circular / missing-field inputs return "" from
   `lowerMessage` / `lowerProviderCode` — they fall back to the
   pre-existing `bad_request` path. No-throw.

### Configurable

Per the task spec the configurability seams are:
- `LLMConfig.onChunk` — surfaced as `StreamInput.onChunk` (per-call
  optional; the StreamInput is the canonical per-call payload to the
  port). `AgentConfig.providerErrorMapping` was considered but
  deliberately NOT added: the new mapping is strict-only (no opt-out
  knob), because the only alternative is the broken 11-kind status quo
  — a `bad_request` for a policy refusal that the loop will retry
  forever. Adding a strict/lax knob would create two production behaviors
  to test; the rejection of that knob is honest.

## Consequences

### Positive

- Spinner-stall soft signal is now actually observable across every
  provider in production. The 30s panel will fire BEFORE the 120s hard
  abort, giving users the "still working… [r]etry / [a]bort" choice
  Claude Code shows.
- Reactive compaction now triggers on the EXACT bucket it's designed for
  (`context_window_exceeded` from 400/422 responses) rather than mis-firing
  on every `bad_request`. Loop won't retry an oversized prompt forever.
- HITL routing now engages on safety/policy refusals at the adapter
  boundary — `cyber_policy` errors hand off to the user immediately
  rather than burning retry budget against a refusal that no amount of
  retry can bypass.
- The 16-kind ADR-0214/0217 contract is now genuinely 16-wide at the
  adapter layer for the kinds the adapter CAN observe. The other 3
  kinds remain emitted only by their owning layers, which is the right
  separation.

### Negative

- The `classify` helper in `src/shared/errors.ts` now matches on
  message text in the 400/422 branch. This is a deliberate exception
  to the downstream ban, justified by the boundary contract above and
  pinned by hellgate, but it's a code-smell that future readers MUST
  evaluate before extending.
- The 5 marker lists in `error-classifier.ts` and the 2 marker lists in
  `errors.ts` are NOT shared — they have different scopes (router-stage
  vs adapter-stage) and merging them would conflate the two boundaries.
  Adding a new marker means TWO edits if both stages should learn it.
  This is the right trade-off (boundary separation) but it's a
  maintenance burden.
- chatgpt-oauth's local `notifyChunkArrival` duplicates the helper in
  `withStreamTimeout`. The two MUST stay in lockstep on the swallow
  contract. A future refactor could promote it to `src/llm/shared/`
  but the wire is correct as-is and chatgpt-oauth is the only
  non-wrapper consumer.

### Neutral

- StreamInput grew one optional field. Producers that don't set it see
  byte-identical wire behaviour.
- The mantle adapter remains a Phase 1 stub. Phase 2 (when Anthropic
  Mantle's spec is public) will inherit this wire automatically by
  passing onChunk through to the new wrapper.

## Hellgate batteries (43 hard cases / 0 fail)

- `tests/unit/llm-providers-onchunk-wire-hellgate.test.ts` — 18 cases:
  WIRE-A (5 providers tick onChunk on every frame), WIRE-B (5 providers
  empty stream → 0 ticks), WIRE-C (monotonic ordering over many chunks),
  WIRE-D (throwing hook → swallowed; stream survives), WIRE-E (absent
  hook → default-OFF, no invented callback).
- `tests/unit/llm-providers-fromsdkerror-16-hellgate.test.ts` — 25 cases:
  F-CTX (5 context_window mappings), F-POL (5 cyber_policy mappings),
  F-PRE (precedence: cyber_policy > context_window > bad_request),
  F-REG (7 regression checks for the original 11 kinds), F-EDGE (4 edge
  cases: empty / pre-wrapped / circular / missing-status), F-CON (2
  constructed LLMError surface assertions).

## Catalog deliberate_hold release

- `tools/feature-catalog/features/08-llm/227-spinner-stall-detection.yaml`
  — release "Provider adapter wire (onChunk injection) — Tier 2 (per-adapter)".
- `tools/feature-catalog/features/07-resilience/llm-error-taxonomy.yaml`
  — update note: "Adapter `fromSdkError` extended in ADR-0234 for the 2
  provider-emitable kinds (context_window_exceeded / cyber_policy);
  the other 3 remain layer-owned by design."
