# ADR-0323 — Image content sanitization in history

- **Status**: accepted (2026-05-27)
- **Related**: ADR-0083 (image block), ADR-0126 / ADR-0137 (tool_result multimodal), ADR-0214 (LLMErrorKind taxonomy), ADR-0234 (adapter-boundary classification)
- **References**:
  - Codex source: `codex-rs/core/src/session/turn.rs:363-381`
  - quanta surfaces: `src/memory/working.ts`, `src/llm/types.ts:1-122`, `src/shared/errors.ts:110-185, 321-334`

## Context

Codex's `run_turn` loop has an explicit "history poisoned by an invalid image"
recovery path. When the provider returns `CodexErr::InvalidImageRequest()`, the
session lock acquires `state.history.replace_last_turn_images("Invalid image")`,
which walks the last turn's content blocks, rewrites every image to a text
placeholder, and returns a boolean indicating whether anything was actually
mutated. The outer `match` then `continue`s the loop so the next sample sees a
clean buffer; if nothing matched the mutation, a user-facing error event is
emitted and the turn breaks. The full Codex arm:

```rust
Err(CodexErr::InvalidImageRequest()) => {
    let mut state = sess.state.lock().await;
    error_or_panic("Invalid image detected; sanitizing tool output to prevent poisoning");
    if state.history.replace_last_turn_images("Invalid image") {
        continue;
    }
    // … fall through to user-facing error + break
}
```

quanta has no equivalent path. Grep confirms it:

- `src/shared/errors.ts:321-334` (`classifyBadRequest`) routes the Anthropic
  400 invalid-image response to the generic `bad_request` kind — there is no
  `invalid_image` arm.
- `src/llm/adapters/anthropic.ts:366, 409` wraps the SDK error with
  `LLMError.fromSdkError("anthropic", e)` and re-throws. Nothing downstream
  inspects the cause for image-related provider error codes.
- `src/memory/working.ts` exposes `replace(messages: M[])` and `snapshot()` —
  the in-place mutation primitive Codex needs is reachable, but no caller uses
  it for image scrubbing.

Concrete failure mode that this gap allows today:

1. The user attaches a malformed or rejected image (e.g. base64 corruption,
   wrong `mediaType`, or a host-content moderation refusal).
2. The Anthropic adapter throws `LLMError{kind:"bad_request"}`.
3. The retry / fallback router (`src/llm/retry/codex-spec-router.ts`) treats
   `bad_request` as a caller-bug class (`HITL` typically), but in same-turn
   retry paths the offending `ImageBlock` is still in `WorkingMemory`.
4. Every subsequent sample re-sends the same bytes, burns tokens, and
   eventually hits the soft-stall detector (ADR-0227) or the hard idle
   abort (ADR-0200) — none of which fix the root cause.

A poisoned image left in the buffer also survives a same-thread retry from
`too_many_failed_attempts` (ADR-0214), so the budget breaker may trip on what
is structurally one bad attachment.

## Decision

Land a closed-port slice `src/memory/history-sanitization/` that exposes the
Codex mutation primitive without wiring any production call site.

### Port

```ts
type SanitizationReason = "invalid_image" | "oversize" | "denied"

interface SanitizationResult {
  readonly replacedCount: number
  readonly wasMutated: boolean
}

interface HistorySanitizationPort {
  /** Replace every image/document block in the LAST message (incl. tool_result inner content) with a text placeholder. NO-THROW. */
  replaceLastTurnImages(reason: SanitizationReason, placeholder: string): SanitizationResult
  /** Same, scoped to the last N messages. NO-THROW. */
  replaceLastNMessagesImages(n: number, reason: SanitizationReason, placeholder: string): SanitizationResult
}
```

The single bundled adapter, `createWorkingMemoryHistorySanitization(wm)`,
binds the port to a `WorkingMemory<Message>` instance. It uses the documented
`wm.snapshot()` + `wm.replace(...)` API for mutation — NOT `wm.messages` —
because the buffer's invariant (header comment of `working.ts`) is that
message OBJECTS are treated as structurally immutable; we always hand back a
fresh content array on touched messages and preserve identity on untouched
ones.

### Slice fence

- The slice does NOT import `@/llm`. Block shapes (`image`, `document`,
  `tool_result.contentBlocks`) are matched structurally on a local `BlockLike`
  type — the same posture `@/memory` already enforces (`biome.json:122-136`).
- The barrel does NOT re-export from `src/memory/index.ts`. Production wiring
  requires a follow-up ADR (see "Wiring" below).
- Default-OFF: no caller invokes the port today. Building, importing, or
  ignoring the new directory is byte-identical to pre-ADR behaviour.

### NO-THROW contract

The port is a recovery primitive. If it threw, the agent loop would be in a
worse state than the original 400. Adapters catch any exception inside the
mutation loop and resolve to `{replacedCount:0, wasMutated:false}`.

## Non-goals

- **Production wire-up.** The Anthropic adapter's `bad_request` branch is not
  modified. Wiring `replaceLastTurnImages` into a future `invalid_image`
  classification + same-turn `continue` policy is a separate ADR.
- **Adapter-boundary error classification.** Today's 400 invalid-image lands
  on `bad_request`; we are not adding an `invalid_image` `LLMErrorKind` here.
  That would require ADR-0214 / ADR-0234 amendments (recovery-router switch,
  marker list, OpenAI / Bedrock / Vertex parity).
- **Retry / fallback policy.** The Codex parent both mutates AND `continue`s
  the loop. This slice only ships the mutation half; the retry trigger is the
  wiring ADR's responsibility.
- **Other content kinds.** Audio (ADR-0202 / ADR-0208 voice), thinking blocks
  (ADR-0076), and `tool_use` are all explicitly out of scope — `POISONABLE_BLOCK_TYPES`
  is `{image, document}` and adding more requires a new ADR.
- **Telemetry.** The port returns a typed result; emitting events / metrics on
  it is a wiring concern, not a slice concern.

## Wiring (out of scope, future ADR sketch)

A follow-up ADR is expected to:

1. Extend `LLMErrorKind` with `invalid_image` and have
   `classifyBadRequest` (`src/shared/errors.ts:321`) route Anthropic's
   `invalid_request_error` + image-marker body to it. Update the recovery
   router (`src/llm/retry/codex-spec-router.ts`) exhaustive switch.
2. In the agent loop's same-turn retry path, when the classified kind is
   `invalid_image`, call
   `port.replaceLastTurnImages("invalid_image", "Invalid image")` and on
   `wasMutated:true` re-sample. On `wasMutated:false` surface the typed error
   to HITL (the Codex `break` arm).
3. Mirror in OpenAI / Bedrock / Vertex / Foundry adapters.

None of those steps land here; the slice exists so the future ADR's wiring
patch is a one-line `import { createWorkingMemoryHistorySanitization } from
"@/memory/history-sanitization"`.

## Consequences

- **Positive**: closed mutation primitive ready for the future wire-up;
  Codex-parity recovery surface that does not currently exist; hellgate coverage
  for the recovery semantics independently of any wiring.
- **Negative**: a default-OFF slice is dead code until the wiring ADR lands.
  Mitigated by the explicit "Non-goals" + "Wiring" sections so an architect
  reading the ADR alone can wire it.
- **Audit trail**: every multimodal-error path that currently does nothing
  (Anthropic 400, OpenAI image rejection, image moderation refusal) now has a
  documented recovery primitive it can hook into.
