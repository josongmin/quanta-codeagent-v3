# ADR-0337 — image-retry wm-live snapshot on sanitize-and-retry

## Status

Accepted (2026-05-27). Closes the ADR-0328 / ADR-0333 §Limitations entry
"Stale `input.messages` on retry."

## Related

- ADR-0323 — `HistorySanitizationPort` + `WorkingMemory` adapter.
- ADR-0328 — `withImageSanitizationRetry` decorator + `invalid_image`
  `LLMErrorKind`. This ADR extends ADR-0328's retry semantics.
- ADR-0333 — production hookup of `withImageSanitizationRetry` in
  `createRunAgentContext`. This ADR closes ADR-0333 §Limitations row 1.
- ADR-0320 — closed-port extension log pattern. This ADR follows the same
  pattern for ADR-0323's port surface.

## Context

ADR-0328 ships `withImageSanitizationRetry`, a closed-port `LLMPort` wrap
that mirrors Codex's `replace_last_turn_images → continue` recovery arm
(`codex-rs/core/src/session/turn.rs:363-381`). On an `LLMError("invalid_image",
...)` thrown by the inner stream BEFORE any event is yielded, the wrap calls
`port.replaceLastTurnImages("invalid_image", placeholder)` to sanitize the
working-memory buffer, then re-invokes the inner adapter.

ADR-0333 documented this verbatim limitation:

> **Stale `input.messages` on retry.** The wrap re-passes the SAME `input`
> reference. The wm is mutated by `port.replaceLastTurnImages` but
> `input.messages` was snapshotted by the loop before the call. Under
> Codex's model `input.messages` IS the wm so the model sees the sanitized
> turn on retry; under our snapshot-decoupled model the retry sees the
> stale list. A future ADR may convert `input.messages` to a wm-live
> reference (or pass a re-snapshot callback into the wrap). Out of scope
> here.

Verification of the stale-input fact (file:line at the time of this ADR):

- `src/llm/image-sanitization-retry/wrapping.ts:185-198` (pre-ADR-0337)
  ran the inner stream inside `for (let attempt = 0; attempt <= maxAttempts; attempt++)`
  and called `inner.stream(input)` on every attempt — the SAME `input`
  reference, including the SAME `input.messages` array the loop assembled
  BEFORE the pre-sanitize attempt.
- `src/agent/loop.ts:2206` wires the wrap via `cfg.llm = maybeWrapImageSanitizationRetry(cfg, wm)`.
  The wm passed to the port factory is the SAME wm the loop snapshots into
  `input.messages` (`buildSeedMessages` → `createWorkingMemory<Message>`).
- `src/memory/history-sanitization/working-memory-adapter.ts` mutates the
  wm via `wm.replace(next)` (line 205 pre-ADR-0337) — observable to a
  subsequent `wm.snapshot()` but NOT to a reference to the previously
  returned snapshot array.

Concrete failure: a provider 400 on `invalid_image`, sanitize succeeds
(`wasMutated:true`), but the retry re-serializes the original `messages`
array because the decorator never asks the wm for a fresh snapshot. The
provider re-rejects with the same 400 and the wrap propagates the second
error — sanitize did its job but the retry never benefited.

## Decision

Extend `HistorySanitizationPort` with a no-throw read accessor
`snapshotMessages()` and use it inside `withImageSanitizationRetry` to
rebuild the retry `StreamInput` so it reflects the post-sanitize wm.

### Port surface — closed-port extension

The interface gains exactly one member:

```ts
interface SanitizationMessageLike {
  readonly role: string
  readonly content: unknown
}

interface HistorySanitizationPort {
  // existing two methods unchanged …
  replaceLastTurnImages(reason, placeholder): SanitizationResult
  replaceLastNMessagesImages(n, reason, placeholder): SanitizationResult

  // ADR-0337 — read accessor for retry decorators.
  snapshotMessages(): readonly SanitizationMessageLike[]
}
```

Contract:

- **NO-THROW.** Default adapter wraps `wm.snapshot()` in a `try / catch`
  shim (`safeSnapshot`); a thrown error collapses to `[]`. Consumers
  interpret `[]` as "fall back to the caller's `input.messages`".
- **Snapshot semantics.** The return is a shallow copy / `readonly` view;
  mutating it MUST NOT poison the wm. Default adapter delegates to the
  existing `wm.snapshot()`, which is already a defensive shallow copy.
- **Structural shape.** `SanitizationMessageLike` is `{role: string,
  content: unknown}` — wide enough to keep the `@/memory` slice from
  importing `@/llm`. Retry decorators cast at the wire boundary
  (`as readonly Message[]`).

### ADR-0323 closed-port extension justification

ADR-0323 §Port sealed two members. Widening requires a new ADR (per the
closed-port discipline used by ADR-0320). The justification for adding a
sibling method rather than a parallel port:

1. **Same lifecycle binding.** `snapshotMessages` reads the SAME wm that
   `replaceLastTurnImages` mutates. A second port would force every wire
   site to pair them and would invite drift (the wm reference could
   accidentally differ between the two ports).
2. **Recovery cohesion.** The port's purpose is "let a recovery decorator
   read AND mutate the in-session message buffer through a slice-fence".
   The read half was missing only because the original ADR-0323 had no
   consumer for it.
3. **Closed-set log discipline.** The amendment is recorded in
   `src/memory/history-sanitization/port.ts` under a new
   **Closed-port extension log** section (mirror of ADR-0320's "Closed-set
   extension log"). Date / ADR / transition / added member / 1-line
   rationale are pinned in the file so future audits see the amendment
   without leaving the source.

The replace-method signatures are UNCHANGED. The existing
`createWorkingMemoryHistorySanitization` factory simply gains a third
property on its returned object literal.

### Decorator change

`src/llm/image-sanitization-retry/wrapping.ts` — `stream()` body:

```ts
// pre-ADR-0337
for (let attempt = 0; attempt <= maxAttempts; attempt++) {
  let yielded = false
  try {
    for await (const ev of inner.stream(input)) { /* … */ }
    return
  } catch (e) {
    if (decideRecovery(e, yielded, attempt, maxAttempts, sanitize) === "throw") throw e
    // (no rebuild — retry reused `input`)
  }
}
```

```ts
// post-ADR-0337
let currentInput = input
for (let attempt = 0; attempt <= maxAttempts; attempt++) {
  let yielded = false
  try {
    for await (const ev of inner.stream(currentInput)) { /* … */ }
    return
  } catch (e) {
    if (decideRecovery(e, yielded, attempt, maxAttempts, sanitize) === "throw") throw e
    currentInput = buildWmLiveInput(port, currentInput)
  }
}
```

`buildWmLiveInput` (new helper in the same file):

- Calls `port.snapshotMessages()` inside a `try / catch`. Any thrown value
  collapses to the prior `currentInput` (fallback).
- Empty / non-array return ⇒ fallback (degenerate adapter signals "use the
  caller's reference").
- Otherwise: spread `currentInput` and overwrite ONLY `messages` with a
  defensive `.slice()` of the snapshot (StreamInput.messages is declared
  mutable; we must sever the readonly view).

All other `StreamInput` knobs (`tools`, `system`, `toolChoice`,
`thinking`, `signal`, `turnTimingCapture`, `onChunk`) are preserved by-
reference via the spread. The wire-shape change on retry is EXACTLY the
`messages` field; everything else is byte-identical.

### Byte-identical for legacy callers

A consumer that calls `withImageSanitizationRetry` with a port that
returns `[]` from `snapshotMessages` (or whose `snapshotMessages` throws)
gets the pre-ADR-0337 behaviour: retry sees the caller's stale
`input.messages`. This preserves binary compatibility for any hand-rolled
test mock that was written against ADR-0328's contract. The 19 original
`wrapping.hellgate.test.ts` cases all continue to pass because they used
recording mocks whose default `snapshotResults` is now `undefined` ⇒
`snapshotDefault: []` ⇒ fallback path.

The happy path (no `invalid_image` thrown) NEVER calls `snapshotMessages`
— the first attempt always uses the caller's `input` verbatim. This is
asserted by hellgate.

## Non-goals

- **Provider-adapter wm-live reads.** Inner adapters (`anthropic`,
  `chatgpt-oauth`, etc.) STILL read `input.messages` by-reference at call
  time. Pushing the wm-live read into the adapter itself would replace
  the snapshot model wholesale and is out of scope. The decorator alone is
  enough to close the retry gap because the retry IS the only path where
  the adapter is re-invoked with a now-stale snapshot.
- **`replaceLastNMessagesImages` retry.** The wrap only invokes the
  Codex-parity last-turn method. A future ADR may add a second wrap that
  uses the multi-turn variant; that would re-use the same
  `snapshotMessages` accessor.
- **Cancelling in-flight retries.** Mid-stream throws still propagate
  verbatim (ADR-0328 invariant unchanged).
- **Production wire toggle.** `cfg.imageSanitizationRetry.enabled` (ADR-
  0333) still governs whether the wrap engages. This ADR only changes
  what happens INSIDE the wrap once `enabled === true`.

## Tests

`src/memory/history-sanitization/__tests__/working-memory-adapter.hellgate.test.ts`
gains 6 new cases:

- empty wm ⇒ `[]`
- multi-turn buffer ⇒ exact element-identity-preserving tail
- snapshot reflects POST-sanitize state after `replaceLastTurnImages`
- mutating the returned array does NOT poison the wm (shallow-copy)
- hostile wm whose `.snapshot()` throws ⇒ `[]` (NO-THROW shim)
- structural `SanitizationMessageLike` shape (`role: string`, `content:
  unknown`)

`src/llm/image-sanitization-retry/__tests__/wrapping.hellgate.test.ts`
gains a new `describe("ADR-0337 wm-live re-snapshot on retry")` block with
8 cases:

- retry `input.messages === port.snapshotMessages()` result
- `snapshotMessages` throws ⇒ fall back to caller's `input.messages`
- `snapshotMessages` returns `[]` ⇒ fall back to caller's `input.messages`
- other StreamInput knobs (`tools`, `system`, `toolChoice`, `thinking`,
  `signal`, `turnTimingCapture`, `onChunk`) preserved across retry
- happy path (no retry) NEVER calls `snapshotMessages` — byte-identical
- `snapshotMessages` NOT called when sanitize returned `wasMutated:false`
- two successive retries each rebuild from a fresh snapshot (`maxAttempts:2`)
- end-to-end with real `createWorkingMemoryHistorySanitization(wm)` +
  `createWorkingMemory<Message>` — proves the closed-port extension is
  wired straight through `wm.snapshot()`

The existing 19 cases all continue to pass: their recording-port mocks
now default `snapshotMessages` to `[]`, which routes through the
fallback path. The retry-input assertion in those cases (which never
inspected `input.messages` past identity) is untouched.

`tests/unit/loop-image-retry-hookup-hellgate.test.ts` (ADR-0333) is
untouched — the hookup helper code is unchanged.

## References

- `src/memory/history-sanitization/port.ts` — closed-port extension log +
  `SanitizationMessageLike` + `snapshotMessages` member.
- `src/memory/history-sanitization/working-memory-adapter.ts` —
  `safeSnapshot` shim + `snapshotMessages` impl on the factory.
- `src/memory/history-sanitization/index.ts` — re-export
  `SanitizationMessageLike`.
- `src/llm/image-sanitization-retry/wrapping.ts` — `buildWmLiveInput`
  helper + `currentInput` rebind in `stream()`.
- ADR-0320 — closed-set extension log pattern (template followed here).
- ADR-0323 — original port surface (amended by this ADR's port-file
  extension log).
- ADR-0328 — `withImageSanitizationRetry` (retry semantics extended here).
- ADR-0333 §Limitations row 1 — closed by this ADR.
