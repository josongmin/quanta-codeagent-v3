# ADR-0328 — invalid_image classification + sanitization-retry wire (ADR-0323 production wire)

## Status
Accepted and landed. Slice + production hookup both in main: the wrap mutates
`cfg.llm` inside `createRunAgentContext` immediately after `wm` is built
(`src/agent/loop.ts` — `maybeWrapImageSanitizationRetry`). The ownership
concern flagged in §Wiring was resolved in the same change by collapsing the
`cfg` clone gate from `dedupGateActive && baseCfg === config` to
`baseCfg === config` — `cfg` is now a per-run clone whenever
`buildEffectiveConfig` would otherwise return the caller's reference, so
every existing mutation in this function (`onPlanExitOutcome`,
`shellSnapshotSession`, dedup-gate / cap-enforcer / localize-phase attaches,
and now `cfg.llm`) is leak-safe.

## Context

ADR-0323 shipped a closed `HistorySanitizationPort` (`src/memory/history-sanitization/`) with the `WorkingMemory`-backed adapter that scrubs `image` / `document` blocks from the trailing message(s). At ship time, no production caller invoked the port — wiring it at the Anthropic adapter's 400-invalid_image boundary was explicitly deferred to a follow-up ADR ("Non-goals" §).

Codex parity (`codex-rs/core/src/session/turn.rs:363-381`):

```rust
Err(CodexErr::InvalidImageRequest()) => {
    let mut state = sess.state.lock().await;
    error_or_panic("Invalid image detected; sanitizing tool output to prevent poisoning");
    if state.history.replace_last_turn_images("Invalid image") {
        continue;  // history mutated ⇒ re-sample
    }
    let event = EventMsg::Error(ErrorEvent { ... });
    sess.send_event(&turn_context, event).await;
    break;
}
```

quanta has had a port; quanta has had no boundary that emits `invalid_image`; quanta has had no wrap that calls the port on that boundary. Every poisoned image in `WorkingMemory<Message>` therefore drove the loop to retry the same bytes forever (in the worst case) or fail-fast as a `bad_request` (in the common case) — both losing the recovery Codex enjoyed.

This ADR closes the three gaps:

1. **Classify** `invalid_image` at the LLM adapter boundary.
2. **Wrap** any `LLMPort` with a `withImageSanitizationRetry` decorator that consumes the ADR-0323 port and retries once after sanitization.
3. **Schema-slot** the wrap in `AgentConfig` so the production hookup (one mutation in `createRunAgentContext`) is a straight follow-up.

## Decision

### 1. New `LLMErrorKind` member `"invalid_image"`

Added to the closed union in `src/shared/errors.ts`. The 16-arm taxonomy becomes 17. The new arm is **provider-emitable** (not layer-owned) — the adapter boundary stamps it from the SDK error.

### 2. Classifier branch in `classifyBadRequest`

`src/shared/errors.ts::classifyBadRequest` gains a third match (before the `bad_request` fallback), precedence-ordered:

```
cyber_policy > context_window_exceeded > invalid_image > bad_request
```

**Rationale**: A refusal that ALSO mentions "invalid image" must route to HITL (`cyber_policy` wins). A 400 that mentions "context length" AND "invalid image" must route to compaction — sanitizing one image will not shrink an oversize prompt. Only when both higher-priority routes miss does `invalid_image` fire.

**Marker basis** (conservative — no SDK error code is broken out today for this case; the only available signal is the body text):

- Anthropic surfaces this as `400 invalid_request_error` with messages like `"could not process image"`, `"unable to process image"`, `"image dimensions exceed N"`, `"unsupported image type"`. The marker set is the lowercased substring intersection of those phrases, narrowed to the most distinctive surface (`"invalid image"`, `"could not process image"`, `"unable to process image"`, `"image dimensions"`, `"unsupported image type"`, `"image format"`).
- A provider-code probe is encoded BEFORE the substring fallback: `.error.type === "invalid_image"` or `"invalid_image_request"` short-circuits the marker scan. When the SDK adds a structured code, the substring fallback will continue to work as the safety net.
- `"document"` parity is intentional: ADR-0137 native-document blocks (`type:"document"`) surface the same failure shape.

**Limitation**: The marker list is best-effort. A provider that returns a non-listed phrase (e.g. a future Anthropic update) routes to `bad_request` instead of `invalid_image`, which preserves the byte-identical legacy behavior (no sanitize, fatal abort). A new marker is one-line addition to `ADAPTER_INVALID_IMAGE_MARKERS` + a hellgate case.

### 3. Closed-port wrap `withImageSanitizationRetry`

New slice `src/llm/image-sanitization-retry/` (sibling to `src/llm/spinner-stall/`):

```ts
export const withImageSanitizationRetry = (
  inner: LLMPort,
  port: HistorySanitizationPort,
  opts?: ImageSanitizationRetryOptions,
): LLMPort
```

Decorates an inner `LLMPort` so an `LLMError("invalid_image", ...)` thrown BEFORE any event is yielded triggers a sanitize-and-retry pass via `port.replaceLastTurnImages("invalid_image", placeholder)`. Up to `maxAttempts` re-streams are attempted. Behavior matches Codex `turn.rs:363-381` verbatim:

- **Pre-stream throw + invalid_image + budget ⇒ sanitize + retry** (Codex `continue`).
- **`replaceLastTurnImages` returns `wasMutated:false` ⇒ propagate original** (Codex `break`, no Error event emitted by the wrap — that surface is the caller's).
- **Out of budget ⇒ propagate the LAST invalid_image error** (the outer router maps `invalid_image` → fatal, same policy as `bad_request`).
- **Mid-stream throw ⇒ never sanitize** (the provider already accepted the image; sanitizing would corrupt the transcript).
- **Non-invalid_image error ⇒ propagate verbatim** (no port interaction).
- **Port throws ⇒ swallowed by no-throw shim; propagate original** (ADR-0323 port contract says it never throws, but the wrap is the load-bearing recovery seam — a port bug must not crash the live loop).

### 4. Default policy: OFF at the AgentConfig slot

The `AgentConfig.imageSanitizationRetry` slot is shape-only when omitted. The wrap is opt-in via `enabled: true`. This deviates from the original task draft (which proposed default-ON) for a defensible reason:

- **Default-OFF preserves byte-identical legacy behavior.** Until the production hookup lands and is hellgate-pinned at the loop level, every existing AgentConfig instance must see zero observable change. The wrap is provably-correct in isolation but the wm/cfg.llm coupling at the wire site requires its own audit.
- **Codex parity is preserved by default-ON inside the wrap.** When the host opts in (`enabled: true`), the defaults are `maxAttempts: 1` + `placeholder: "[invalid image removed]"` — Codex behavior verbatim modulo the placeholder string (Codex uses `"Invalid image"`; our default reads cleaner in the transcript surface).

### 5. Knob schema

```ts
imageSanitizationRetry?: {
  readonly enabled?: boolean        // default: false
  readonly maxAttempts?: number     // default: 1, clamped to [0, 5]
  readonly placeholder?: string     // default: "[invalid image removed]"
}
```

`maxAttempts: 0` (or `enabled: false`) ⇒ identity wrap (returns inner verbatim, no allocation).

### 6. Downstream routing

After sanitize-retry exhausts, the `invalid_image` LLMError propagates. Three outer consumers were updated to map it consistently:

- `src/llm/retry/codex-spec-router.ts` — `invalid_image → fatal` (same policy as `bad_request`).
- `src/agent/error-routing/default-classifier.ts` — `invalid_image → { kind: "badRequest", message }` (the typed-error router maps `badRequest → abort`).
- `src/agent/retry.ts` — added to `FATAL_KINDS` set so `isRetryable()` returns `false` and `classifyLLMError()` returns `"fatal"`.

All three consumers express the same negative invariant: by the time `invalid_image` escapes the wrap, mechanical recovery is exhausted. Further same-provider retry or provider fallback would re-poison the history.

## Files changed

### New slice (`src/llm/image-sanitization-retry/`)
- `types.ts` — `ImageSanitizationRetryOptions`, `DEFAULT_MAX_ATTEMPTS`, `DEFAULT_PLACEHOLDER`.
- `wrapping.ts` — `withImageSanitizationRetry` + `decideRecovery` helper + `safeSanitize` no-throw shim.
- `index.ts` — barrel.
- `__tests__/wrapping.hellgate.test.ts` — 19 cases / 50 expects.

### Existing files touched (slice-fence-clean, every change behind the new code path)
- `src/shared/errors.ts` — `LLMErrorKind` += `"invalid_image"`; `classifyBadRequest` += third branch; `ADAPTER_INVALID_IMAGE_MARKERS` const.
- `src/shared/error-classifier.ts` — heuristic ladder += `INVALID_IMAGE_MARKERS` (mirrored set, kept in sync); docstring updated.
- `src/llm/retry/codex-spec-router.ts` — exhaustive switch += `case "invalid_image": return "fatal"`.
- `src/agent/error-routing/default-classifier.ts` — exhaustive switch += `case "invalid_image": return { kind: "badRequest", message }`.
- `src/agent/retry.ts` — `FATAL_KINDS` += `"invalid_image"`.
- `src/agent/types.ts` — `AgentConfig.imageSanitizationRetry?` slot (schema-only, no wire).

## Wiring (follow-up)

The production hookup is a single mutation in `createRunAgentContext` (`src/agent/loop.ts:~2049`), right after `wm` is built:

```ts
// ── ADR-0328 image sanitization retry wire ──────────────────────────
if (cfg.imageSanitizationRetry?.enabled === true) {
  const port = createWorkingMemoryHistorySanitization(wm)
  const wrapOpts = {
    ...(cfg.imageSanitizationRetry.maxAttempts !== undefined
      ? { maxAttempts: cfg.imageSanitizationRetry.maxAttempts }
      : {}),
    ...(cfg.imageSanitizationRetry.placeholder !== undefined
      ? { placeholder: cfg.imageSanitizationRetry.placeholder }
      : {}),
  }
  cfg.llm = withImageSanitizationRetry(cfg.llm, port, wrapOpts)
}
```

**Why this is a follow-up and not in-slice**: `cfg` in `createRunAgentContext` may share its reference with the caller's `config` (only shallow-cloned when `dedupGateActive && baseCfg === config`). Mutating `cfg.llm` in non-clone paths would leak to the caller. The existing line that mutates `cfg.onPlanExitOutcome` has the same risk profile; resolving the underlying ownership question is a parallel concern. The slice ships the wrap so the hookup is one isolated mutation under hellgate audit when it lands.

## Non-goals

- **Cross-provider parity**: OpenAI / Bedrock / Vertex / Foundry / chatgpt-oauth adapters are NOT updated. The OpenAI 400 surface uses a different shape (`error.code === "image_parse_error"` and similar) and warrants its own slice. The chatgpt-oauth `statusToKind` is provider-aware and emits `bad_request` for 400; the wrap is provider-agnostic but the classifier markers were tuned for Anthropic. A follow-up ADR will mirror the marker set + provider-code probe for the other adapters.
- **Wrap recovery policy generalization**: The wrap is single-purpose (invalid_image only). A future general-purpose "recover-via-mutation" decorator (e.g. for other 400 shapes that have a structural recovery) would share the closed-port pattern but not the same vocabulary.
- **History event for the sanitization**: ADR-0320 typed history events do NOT emit a "history sanitized" event from this slice. The sanitization is observable in the transcript (the placeholder text appears in the next snapshot) but is silent on the event channel. A follow-up may add `{ kind: "history_sanitized", replacedCount }` to the typed-event slice.

## Test coverage

19 hellgate cases / 50 expects (`src/llm/image-sanitization-retry/__tests__/wrapping.hellgate.test.ts`):

1. non-invalid_image error propagates verbatim, no sanitize
2. invalid_image → sanitize once + retry yields events
3. invalid_image x2: sanitize once, retry still invalid_image, throw last
4. sanitize wasMutated:false ⇒ propagate original (Codex parity break)
5. maxAttempts=0 ⇒ identity wrap (`wrapped === inner`)
6. maxAttempts=2 ⇒ sanitize twice
7. port throws ⇒ swallowed; propagate original
8. placeholder option forwarded into port call
9. default placeholder = `"[invalid image removed]"`
10. non-LLMError raw thrown ⇒ propagated verbatim
11. LLMError(`bad_request`) ⇒ no sanitize
12. normal completion ⇒ single inner call, no sanitize
13. mid-stream throw (invalid_image after yield) ⇒ never sanitize
14. clamp: negative maxAttempts → 0 (identity)
15. clamp: NaN / Infinity → default (1)
16. clamp: huge → capped to 5
17. model / provider / authMode metadata forwarded from inner
18. exactOptional honest (no `key: undefined` when inner omits)
19. `replaceLastNMessagesImages` NEVER called (Codex parity: last-turn only)

## Verification

- `bunx tsc --noEmit` — 0 errors attributable to this slice (32 pre-existing errors in `@/observability/coverage` modules untouched).
- `bunx biome check src/llm/image-sanitization-retry/ src/shared/errors.ts src/shared/error-classifier.ts src/llm/retry/codex-spec-router.ts src/agent/error-routing/default-classifier.ts src/agent/retry.ts` — 0 errors attributable to this slice (1 pre-existing `classify` complexity 16 + 1 pre-existing format warning in `errors.ts` from before this slice).
- 241 impacted hellgate / unit tests pass — `fallback`, `recovery`, `llm-providers-fromsdkerror-16`, `retry`, `recovery-router`, `retry-pretry`, `critical-surfaces`, `error-classifier`, `error-routing-wire`, `vertex-adapter`, `bedrock-adapter`, plus the 19 new wrapping hellgate cases.

## References

- ADR-0323 — `HistorySanitizationPort` (the port this ADR consumes).
- ADR-0214 — typed-error 16-kind enum (this ADR extends to 17).
- ADR-0234 — adapter-boundary heuristic classification policy (the precedent this slice follows for the marker scan).
- ADR-0237 — `withFailureCounter` / `withSandboxLlmErrorEmit` (sibling pattern decorators).
- Codex `codex-rs/core/src/session/turn.rs:363-381` — Codex `CodexErr::InvalidImageRequest` handling.
