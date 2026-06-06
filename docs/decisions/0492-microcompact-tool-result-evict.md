# ADR-0492: microcompaction — tier-1 tool-result eviction (in-place content clearing)

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - RFC `docs/plans/jun-6-microcompaction.md` (Status ✅ IMPLEMENTED, §10 as-built: Phase 1 pure pre-pass + Phase 2 tier-1 wire; Phase 3 context_hint/CLI deferred).
  - Absorbs cc-cli 2.1.150 `tengu_time_based_microcompact`.
  - ADR-0409 `src/agent/microcompact/` (compaction-visibility) — a DIFFERENT mechanism (whole-MESSAGE drop, no orphan guard, unwired); this slice is in-place tool-result CONTENT clearing (orphan-safe, wired). Not to be confused.
- **참조**:
  - `src/agent/tool-result-evict/` (`types.ts`/`evict.ts`/`spill-adapter.ts`/`index.ts`) — pure pre-pass `microcompactToolResults`: forward-scan, keep last N tool_results intact, rewrite older bodies in place to `[Old tool result content cleared]` (+ spill ref).
  - `src/agent/loop/compaction-wire.ts` — tier-1 fires inside `maybeCompact` BEFORE the bg reconcile + `compactIfNeeded`, knob-gated + min-interval cadence; installs via `wm.replace(...)` (counter reseed); emits `recovery:{reason:"compact",detail:"microcompact"}`.
  - `src/tool/output-spill.ts` — the evicted original persists to the SAME `.quanta/tool-output` surface (+ `pruneSpillDir`) as the capture-time cap.
  - `src/shared/runtime-config.ts`.
  - Tests: `tests/unit/microcompaction-evict-hellgate.test.ts`, `tests/unit/microcompaction-x-token-delta-hellgate.test.ts`, `tests/integration/microcompaction-tier-e2e.test.ts`.
  - Feature catalog: `tools/feature-catalog/features/04-context-management/microcompact-tool-result-evict.yaml`.

## Context

quanta reclaims context two ways and neither shrinks a stale tool dump in place:
tier-0 capture-time per-result cap (`output-spill.ts`) and tier-2 full LLM
summarization (`compactIfNeeded`, expensive + collapses all reasoning). A
transcript can sit UNDER the summarization threshold yet still be bloated by old,
no-longer-referenced large-but-under-cap tool dumps. The missing tier-1 reclaims
that space at zero LLM cost.

## Decision

Add a PURE pre-pass `microcompactToolResults` as a CHEAPER first tier in front of
`compactIfNeeded`: keep the last N tool_results (live working set), clear the
BODY of older ones in place to a placeholder (+ a `<persisted-output>` spill ref).
Zero LLM cost, zero loss of conversational reasoning (assistant text + decisions
stay verbatim; only stale tool dumps shrink). Trigger: idempotent skip-if-cleared
+ a `tokensSaved > floor` gate + a time-based min-interval cadence.

## Correctness invariants

- **Orphan-safe by construction.** Clearing CONTENT (not removing the block)
  preserves every `tool_use` ↔ `tool_result` pairing — no boundary walk, no
  orphan set (strictly simpler than findBoundary, strictly safer than the unwired
  whole-message-drop in ADR-0409).
- **Counter reseed (no token drift).** The wire installs the evicted array via
  `wm.replace([...])` so the delta-token counter re-anchors and
  `tokenTotal() === estimateTokens(snapshot())` holds. An in-place
  `wm.messages[i].content = …` would BYPASS the counter and over-report — banned;
  the §6.2 hellgate seals both the correct path (no drift) and the adversarial
  in-place edit (drifts).
- **Floor gate.** Commit only when estimated `tokensSaved > floor`; below it the
  pass is a no-op (don't churn the transcript for ~40 tokens).
- **NO-THROW spill.** A spill-write failure degrades to a bare placeholder.

## Default posture

OFF, byte-identical. Unset `QUANTA_MICROCOMPACT` ⇒ the pre-pass is never
constructed, the spill dir is untouched, and the produced transcript + event
stream are byte-identical (§6.3 OFF case sealed).

## ROI / tradeoff

HIGH: reclaims context with no LLM round-trip and no reasoning loss, on a
strictly simpler/safer invariant than removal-based compaction. L4 is NOT claimed
(cadence defaults are pre-measurement estimates — over-claim avoided);
context_hint/CLI surface deferred to Phase 3.
