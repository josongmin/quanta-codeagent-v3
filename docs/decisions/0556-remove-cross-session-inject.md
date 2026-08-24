# ADR-0556 — Delete the cross-session inject slice (JSONL stage1 mirror, lexical promotion gate, `selectForInject` prompt block) and its two knobs; keep `memory_summary.md`

Status: Accepted (2026-08-25)
Slice: `src/memory/cross-session/` (deleted) · `src/memory/stage1-store/` (deleted) · `src/agent/memory-consolidator-hook.ts` · `src/memory/auto-trigger/` · `src/runner/session-memory-auto.ts` · `src/agent/types/wire-slots-session.ts` · `src/host/runtime/internal/context-binding/` · `src/sdk/runtime/` · `src/apps/headless/` · `src/config/knob-inventory/host.ts`
Feature: `memory-cross-session-inject` (feature-catalog §5-memory) — retired
Related: ADR-0207 (the JSONL `Stage1OutputsStore` sibling store), ADR-0281 (the session-end promotion gate + `QUANTA_MEMORY_THRESHOLD` / `QUANTA_MEMORY_MIN_USAGE`), ADR-0282 (the session-start injector), ADR-0068 (the 2-phase consolidator whose Phase 2 is what survives), ADR-0413 (memory default-ON), ADR-0553 (the delete-not-wire precedent this follows)
Ratchet: `tests/unit/memory/cross-session-inject-removed-ratchet.test.ts`

## Context

Two systems put "memory from prior sessions" into the cached `session_ctx` system-prompt section (`src/agent/prompt-sections.ts`, one cache breakpoint shared by both):

- **System B — cross-session inject (ADR-0207 + 0281 + 0282).** At session end the consolidator hook wrote the freshly distilled row TWICE: the sqlite `Stage1Store.upsert` (Phase 1's real store) and a second `put` into a JSONL mirror (`~/.quanta/memory/stage1.jsonl`, `JsonlFileStage1Store`). The mirror row carried `selectedForPhase2`, decided by `shouldPromoteForInjection` → `lexicalOverlap(summary, siblings) ≥ promoteThreshold` (default 0.7), and `usageCount: 1`. At session start `DefaultCrossSessionInjector.selectForInject` filtered the mirror to `{selectedForPhase2: true, minUsage: 1}`, sorted oldest-first, byte-capped at 8 KiB, and `renderMemorySection` produced a `## Cross-session memory (auto)` block that became `AgentConfig.sessionCtx`.
- **System C — Phase 2 consolidation (ADR-0068).** `runPhase2` reads the sqlite rows, LLM-deduplicates them into `memory_summary.md`, and the wire builder loads that file into `AgentConfig.memorySummaryMd`, which `fourSectionPreset` wraps and prepends to the same `session_ctx` section.

What the audit found, measured on the tree and on this machine's real store rather than on the ADRs:

- **B was dead in effect.** `lexicalOverlap` is Jaccard(candidate tokens, UNION of every sibling's tokens). The union grows with the corpus, so the score's ceiling shrinks as more sessions accumulate — exactly backwards for a "promote when relevant" gate. Measured over the real 15-row mirror: 0.03–0.15 against the 0.7 threshold; even a per-sibling MAX Jaccard reaches only 0.09–0.30. `touch()` — the only thing that raises `usageCount` — had zero production callers (the ADR-0207 "future scheduler" for `touch/prune` never arrived; the real JSONL was 26 lines, all `put`, 0 `touch`, 0 `mark`, 109 KB, never pruned). Real store: 15 entries, 13 selected, 2 with usage ≥ 1, **0 in the intersection ⇒ 0 eligible**. Every default-ON session therefore paid the mirror write and injected an EMPTY block.
- **Tuning was not an option.** ADR-0281 intended a relevance gate (score ≥ threshold ⇒ promote); the 0.7 was never derived from data. Re-deriving it from n=15 would be an arbitrary heuristic. Inverting the gate to "novelty" at 0.7 promotes all 15 rows — also arbitrary, and it would push ~4.5× C's byte count of stale, oldest-first raw summaries into the cached prefix.
- **C already does the job.** `memory_summary.md` on this machine is 1,390 B / 7 bullets, LLM-deduplicated, and covers every fact present in B's 15 raw summaries. B could add zero new facts, only duplicates and staleness.
- **The mirror had no other reader.** Its sole rationale (ADR-0207) was that B read a different store than Phase 2. The only remaining consumer was the H16 auto-dream trigger (`QUANTA_AUTO_DREAM`, default-OFF), which selected through the same `selectForInject` and was therefore `no_op` for the same 0-eligible reason.

So the wire-or-delete question resolves the same way as ADR-0553: the plumbing was complete and reachable, but the design under it could not deliver the effect it promised, and a sibling already delivers it.

## Decision

**DELETE B, keep C.** Prompt output is byte-identical by construction: B contributed the empty string.

Removed in one pass:

- `src/memory/cross-session/**` (`CrossSessionInjector` port, `DefaultCrossSessionInjector`, `renderMemorySection`, `InjectOpts` / `MemorySystemBlock`, `DEFAULT_INJECT_MAX_BYTES`, `MEMORY_SECTION_HEADER`).
- `src/memory/stage1-store/**` (`Stage1OutputsStore` port, `Stage1Entry`, `InMemoryStage1Store`, `JsonlFileStage1Store`).
- In the session-end hook: `mirrorStage1ToOutputsStore`, `tokenize`, `lexicalOverlap`, `shouldPromoteForInjection`, the `stage1OutputsStore` input and the `consolidator.promotionPolicy` field. One distilled session now performs exactly ONE durable store write (the sqlite upsert inside `runPhase1`).
- `AgentConfig.stage1OutputsStore` and every pass-through of it: `SessionDeps` (`runner/assemble/config.ts`), `runAgent`'s hook call (`agent/loop/entry.ts`), `RuntimeContextSnapshot` + `RuntimeContextPatch` (`context-binding/types.ts`), `extendBaseWithMemoryAuto` + `buildOptionalSnapshotFields` (`context-binding/base.ts`), `RuntimeAgentConfigAugments` (`sdk/runtime/base.ts`).
- In `runner/session-memory-auto.ts`: the JSONL store construction, `selectSessionStartMemoryContext`, the `sessionCtx` / `stage1OutputsStore` wire fields, `SessionStartMemoryResult` (`prepareSessionStartMemory` now returns `void` — its remaining job is the Phase 2 auto-trigger check).
- The env knobs `QUANTA_MEMORY_THRESHOLD` and `QUANTA_MEMORY_MIN_USAGE`: removed from the parser (`memory/auto-trigger/wire.ts`, which now reads only `QUANTA_MEMORY_AUTO`), from the knob inventory, and from the catalog knob lists (`memory-auto-trigger`, `0413-memory-learning-default-on`).
- `tests/unit/memory/stage1-store-hellgate.test.ts`, `tests/unit/memory/stage1-store-wire-hellgate.test.ts`, `tests/integration/memory-cross-session-inject-e2e.test.ts`, the two mirror/promotion cases in `tests/unit/memory-consolidator-hook-hellgate.test.ts`, the B-render case in `tests/unit/cli/session-memory-auto.test.ts`, and the `QUANTA_MEMORY_THRESHOLD=1.1` policy case in `tests/integration/memory-auto-trigger-session-end-e2e.test.ts` — each proved behaviour that no longer exists. The e2e lifecycle case now pins what MUST survive: the prior session's row is readable through the next session's own sqlite store.

Re-pointed, not removed:

- **H16 auto-dream** (`buildCrossSessionDreamTrigger`) now takes `stage1Store: Pick<Stage1StorePort, "fetchSince">` and reads every Phase-1 row with `fetchSince(null)`; a local `renderDreamInput` (oldest-first, empty summaries dropped, 8 KiB greedy cap) builds the summarizer's user text. It no longer depends on the dead `selectedForPhase2 && usageCount ≥ 1` filter, so with `QUANTA_AUTO_DREAM=1` it can actually consolidate. Default-OFF is unchanged. Its three host-binding hellgates swap their fakes from a `list()` shape to a `fetchSince()` shape; the trigger-core tests are untouched.

Removed in the follow-up commit once the ADR-0555/0557 lane released `memory-factory.ts` (originally kept as constants because that lane was in flight):

- `TriggerPolicy` / `DEFAULT_TRIGGER_POLICY` (`memory/auto-trigger/types.ts`) and `MemoryAutoSlot.policy` keep their shape because `src/runner/assemble/memory-factory.ts` (ADR-0555, another lane in flight at the time of this change) destructures them into its own `autoTrigger` slot. Nothing in `src/` reads the two fields any more; `assembleMemoryAuto` always returns the constant. The fields and `memory-factory.ts#resolveAutoTrigger` + `MemoryAutoTriggerPolicy` + the `autoTrigger` slot should be deleted together (their only consumers are `tests/unit/memory-factory-hellgate.test.ts` and `tests/integration/memory-default-on-e2e-hellgate.test.ts`). `AgentConfig.memoryConsolidator.promotionPolicy` (`agent/types/memory-config.ts`) is dead for the same reason and goes with them.

Not migrated, not deleted: users' existing `~/.quanta/memory/stage1.jsonl`. It was a strict mirror of `stage1.sqlite` (the hook wrote sqlite first and the mirror second; no path wrote JSONL alone), so no data is lost by ignoring it. The file is left on disk — this change stops reading and writing it; it does not delete user files.

Wire-shape stability: `RuntimeWireSummary.memoryAuto.stage1OutputsStore` (SDK) and `HeadlessRuntimeWires.memoryAuto.stage1OutputsStore` keep their key; the value is now the constant `false`. The web protocol never had the field.

## Consequences

- **Per session end, store writes drop from 2 to 1** (sqlite upsert only). The distill LLM call itself is unchanged (it was always one call; the mirror was a second *write*, not a second call). Session start no longer replays a 109 KB JSONL into memory.
- **Headless / SDK consumers see `memoryAuto.stage1OutputsStore: false`** where they saw `true`; the second-consumer hellgate flips its expectation with the reason inline.
- **The default-off ledger denominator moves.** `memory-cross-session-inject` was a `wired` / `measure-first` row; retiring the catalog entry (label `retired`, no longer `default-off`) removes it from eligibility, so the row is deleted and the plan-doc figures pinned by `default-off-ledger-plan-metrics-ratchet` are recomputed from the loader: 180 → 179 rows, 172 → 171 wired, 95.6% → 95.5%, measure-first 72 → 71 (enable-now 69, repair-first 0, hold 39, non-wired 8 unchanged).
- **Ratchet.** `tests/unit/memory/cross-session-inject-removed-ratchet.test.ts` is a closed-universe guard over `src/**`: no file may contain `stage1OutputsStore`, `JsonlFileStage1Store`, `selectForInject`, `DefaultCrossSessionInjector`, `mirrorStage1ToOutputsStore`, `shouldPromoteForInjection`, `QUANTA_MEMORY_THRESHOLD` or `QUANTA_MEMORY_MIN_USAGE` (doc comments count); type-level `never` sentinels fail `typecheck:tests` if `AgentConfig` or `ConsolidatorHookInput` regrow the slot; a behaviour pin asserts exactly one store write per distilled session end and that a smuggled sibling store receives nothing; and a paired control seeds `memory_summary.md` plus a production-shaped `stage1.jsonl` (one selected/unused row, one used/unselected row — the two real classes) and asserts the live wires' `session_ctx` section is byte-identical to the pure-`memory_summary.md` build with no B header. That control was green before the deletion (B selected nothing) and after it (nothing reads the file) — the paired proof that the prompt did not move.
- **What a future relevance-scored inject would need**, each the negation of a defect found here:
  1. A source that is NOT already summarized into `memory_summary.md` — otherwise it can only add duplicates. Either it injects rows Phase 2 has not consolidated yet (a watermark-bounded "since last Phase 2" window), or it is a retrieval over the raw rows keyed by the current task, not a static prefix.
  2. A threshold measured on real data with a held-out check (precision of "this row helped the next session"), not a constant chosen at design time; and a score whose range does not collapse as the corpus grows (per-row similarity or a retrieval rank, never Jaccard against a union).
  3. A usage signal that something actually raises. If `usageCount` gates eligibility, a production caller must `touch()` on demonstrable use (e.g. the model cited the entry), with a test that shows the count moving; otherwise the gate is a permanent zero.
  4. Proof of non-empty, non-duplicate output on a fixture before it touches the cached prefix — the byte-identity control above inverted into a "block present and disjoint from C" assertion.
