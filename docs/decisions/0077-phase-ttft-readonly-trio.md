# ADR-0077 — Phase marker + TTFT + readonly deny-steer trio

## Status
Accepted (2026-05-21)

## Context
Three orthogonal signals are missing from our turn surface, each in a
different plane. They share one posture: where every existing classifier
reaches for a heuristic, a DECLARED structural answer is available.

1. **Data plane — phase marker.** A trailing TextBlock followed by a
   `tool_use` is *commentary*; one with no later tool call is the *final
   answer*. The relation is structural in `content[]` order, so we tag it
   once as a post-pass on `assembleFromEvents`.
2. **Observability plane — TTFT.** No wall-clock between request open and
   first content byte. We add a `TurnTiming` capture with an idempotent
   first-chunk latch in the stream consumer.
3. **Control plane — readonly deny-steer.** A `deny_and_steer` refusal
   does not tell the model whether retrying with different params is safe.
   `Tool.isReadOnly()` is declared — append a fixed note when true.

## Decision

### A) Phase marker — STRUCTURAL post-pass
- `TextBlock` gains `phase?: "commentary" | "final_answer"`.
- `determinePhases(content)` performs ONE backward scan; a text block is
  `commentary` IFF `∃ j > i : content[j].type === "tool_use"`, else
  `final_answer`. Non-text blocks pass through untouched. Idempotent.
- `assembleFromEvents` calls `determinePhases` after the event-loop. The
  field is OPTIONAL — consumers that don't read it observe the same control
  flow; strict equality tests see the new field and were updated explicitly.

### B) TTFT — captured at stream chunk arrival
- `src/observability/turn-timing.ts` exports `createTurnTimingCapture(clock?)`.
- `markRequestSent` / `markStreamEnd` are called once each by the loop;
  `markFirstToken` is IDEMPOTENT — only the first call records, every later
  call is a no-op (later chunks are not TTFT signal).
- `streaming-dispatch` accepts `onFirstChunk?: () => void`; the engine fires
  it on the first of (`text_delta` | `thinking_delta` | `tool_use_start`).
  A `stream_reset` tombstone resets the latch so the REPLACEMENT stream's
  first chunk is what we measure.
- `AgentOutcome.turnTiming?` surfaces the LAST successful sampling-request's
  snapshot. Absent on runs that never opened a stream.
- New OTel attribute key: `gen_ai.response.time_to_first_token_ms`.

### C) `isReadonly` denial flag — DECLARED, not inferred
- `buildDenySteerMessage(decision, isReadonly?)` appends a fixed note —
  `READONLY_DENY_STEER_NOTE` — when the denied tool's declared readonly
  flag is `true`. Mutating / unknown ⇒ verbatim steer (byte-identical).
- `denyFromConfirm` (admissibility-gate) derives the flag from the
  registry lookup it already performs (`config.registry.get(call.name)?.
  isReadOnly()`). No parallel lookup path.
- The deny `DispatchResult.failure` is populated with
  `{mode: "permission_denied", isReadonly}` so trajectory/permission
  consumers can branch on the typed envelope without re-deriving.

## Rationale
- **No probabilistic logic.** Every decision matches a declared shape
  (`content[].type`, `Tool.isReadOnly()`, `StreamEvent.type`).
- **No fallback paths.** Optional fields spread conditionally; the
  "missing first token" case is `null`, NEVER a synthesized value.
- **One PR, three orthogonal seams** — each plane gets one structural seam.

## Trade-offs
- `TextBlock.phase` adds one optional field; tight equality tests updated.
- `TurnTiming` allocates once per sampling-request (negligible).
- `buildDenySteerMessage` widens with one optional parameter; legacy
  callers keep the old behaviour.

## Negative invariants
1. **`phase` must NEVER be inferred from text content.** The rule is the
   single backward scan; anything else (regex, length heuristic, model
   re-classification) is a violation.
2. **`markFirstToken` MUST stay idempotent.** A second-chunk overwrite
   destroys the TTFT signal.
3. **The readonly note is appended ONLY on `deny_and_steer` AND
   `isReadonly === true`.** Plain `deny` carries no steer; the note must
   not leak into the `deny` content.
4. **`Tool.isReadOnly()` is the single source of truth for the flag.** Do
   not maintain a parallel allowlist of "tools that are read-only".

## Verification
- `tsc --noEmit` clean (pre-existing CLI errors unrelated).
- New unit tests:
  - `tests/unit/llm/assemble-phase.test.ts` (4 sequences + helper invariants)
  - `tests/unit/observability/turn-timing.test.ts` (idempotency + null
    case + arithmetic under injected clock + frozen snapshot)
  - `tests/unit/agent/readonly-deny-steer.test.ts` (note appended on
    read-only deny, absent on mutating deny, registry lookup mirror)
- Existing `assemble-thinking.test.ts` updated to include the new `phase`
  tag — the post-pass touches every assembled message.

## Related
- ADR-0076 — Gap-4 introduced `deny_and_steer`; this ADR extends the steer
  with a readonly-declared note.
- ADR-0074 — Codex OTel span tree; the TTFT key sits alongside existing
  `gen_ai.*` keys.
