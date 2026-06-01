# ADR-0432 — Memory line-level citations + per-thread mode + write-guard

Status: Accepted
Date: 2026-06-02

## Context

Codex's `codex_memories_extension` carries a `MemoryCitationEntry { lineStart,
lineEnd }` shape (1-based, inclusive) so a recalled claim can be grounded to the
exact lines of the stored record, plus a per-thread memory mode and a
budget-aware write-guard.

In quanta today (`src/agent/memory-tools.ts`) the three self-edit memory tools
(`memory_search` / `memory_write` / `memory_update`) are wired
(`src/runner/assemble/tooling.ts`, default-on when a `store` exists). The
existing `MemoryCitation` (ADR-0082, `src/agent/types/agent-outcome.ts`) is
prompt-WINDOW PLACEMENT provenance (`where` enum + `recordId` / `score`), NOT
source-line spans. There is no per-thread memory mode and no write-guard.

## Decision

Extend `MemoryToolsDeps` (the natural seam — `memoryTools(deps)` builds all
three tools) with three independent, default-OFF axes:

1. **Line-level citations** — new `LineCitation { recordId, lineStart, lineEnd }`
   (1-based inclusive, mirrors Codex `MemoryCitationEntry`). When
   `deps.lineCitations` is true, `memory_search` appends a `[L<start>-<end>]`
   span to each result line. The ADR-0082 placement-provenance `MemoryCitation`
   is left untouched (orthogonal name + shape). `lineSpanOf(id, text)` is the
   pure span function (a non-empty record always cites at least `L1-1`).

2. **Per-thread memory mode** — `deps.threadMode: "enabled" | "disabled" |
   "read-only"`.
   - `disabled` ⇒ recall is a no-op (store never read) AND every write/update
     returns a typed `ok:false`.
   - `read-only` ⇒ recall proceeds; writes/updates return typed `ok:false`.
   - `enabled` (default when absent) ⇒ byte-identical legacy behaviour.

3. **Write-guard** — `deps.writeGuard { minRemainingPercent, remainingPercent }`.
   When configured, a `memory_write` / `memory_update` is SKIPPED (typed
   `ok:false`, store untouched) iff `remainingPercent() < minRemainingPercent`.
   `remainingPercent` is supplied by the caller from `BudgetMeter` (ADR-0138) —
   the memory slice never owns a meter; it only reads the 0..100 signal at write
   time. Absent ⇒ no guard (byte-identical). Search (read path) is never gated.

A single `writeBlockReason(verb)` helper centralises the mode + guard refusal so
both write tools share one decision point.

## Consequences

- All three axes are default-OFF: absent config ⇒ recall on, writes on, no line
  spans — byte-identical to the pre-ADR surface. Proven by hellgate equality
  assertions (`evA toEqual evB`).
- `disabled` recall short-circuits before any `store.recall`, so a disabled
  thread incurs zero store I/O.
- The slice stays self-contained: no import of `@/agent/budget` — the remaining
  signal is injected as a `() => number`, keeping the memory slice's hexagonal
  boundary intact and the wiring decision deferred to the assembler.
- `buildUpdatePatch` was extracted to keep `memory_update.execute` under the
  biome cognitive-complexity cap after adding the guard check.

## Wiring (deferred)

`memoryTools(deps)` is constructed in `src/runner/assemble/tooling.ts:139`. The
new fields are not yet threaded from `AgentConfig` — default-OFF means the
current call site is byte-identical. A follow-up wires `threadMode` /
`lineCitations` / `writeGuard` from config + the live `BudgetMeter`.
