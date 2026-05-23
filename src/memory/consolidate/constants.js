/**
 * ADR-0068 — consolidator pipeline invariants (SOTA++ v2).
 *
 * Every cap and threshold lives here. No magic numbers in phase1.ts /
 * phase2.ts / writer.ts / prompt-sections.ts. Tests assert these values
 * directly so a renumbering is a deliberate, reviewable change.
 */
/** Hard cap on user-read MEMORY.md (Phase 2 consolidated). Phase 2 prompt
 *  is instructed to rolling-distill older entries when the assembled
 *  output would exceed this; the writer ALSO enforces a hard rejection
 *  via {@link MemoryWriteError}, so a non-compliant LLM cannot grow the
 *  file unbounded. */
export const MEMORY_MAX_BYTES = 200_000;
/** Hard cap on memory_summary.md — this is the file prepended to the
 *  `session_ctx` prompt section, so cache cost scales with this number.
 *  Kept ~7× smaller than MEMORY.md (full distilled view vs top-of-memory
 *  index). Writer rejects overflow with `MemoryWriteError`. */
export const MEMORY_SUMMARY_MAX_BYTES = 30_000;
/** raw_memories.md has NO size cap — it is the append-only Phase 1
 *  ingestion trail and Phase 2's source of truth on INIT rebuild.
 *  Cleanup is logical (Phase 2 selection of `selectedForPhase2` rows),
 *  not physical. Symbol prevents accidental numeric comparison. */
export const RAW_MEMORIES_NO_CAP = Symbol("raw_memories_no_cap");
/** Skip Phase 1 when the source thread has fewer than this many real
 *  (non-meta) turns. Codex parity: short conversations are LLM-call
 *  cost without distillable signal. */
export const MIN_TURN_THRESHOLD = 3;
/** Phase 2 auto-trigger condition A — fired at session start when
 *  `stage1_outputs` pending count meets this. */
export const PHASE2_AUTO_TRIGGER_PENDING = 5;
/** Phase 2 auto-trigger condition B — fired at session start when
 *  `last_success_at` is older than this. */
export const PHASE2_AUTO_TRIGGER_MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** Default memory_mode for a new thread. OPT-IN — sensitive data
 *  hardening (Codex `threads.memory_mode='enabled'` default is also
 *  effectively opt-in via per-thread flag; we make it explicit at the
 *  type level). Caller (loop.ts) must set `memoryMode: 'enabled'` via
 *  `AgentConfig.memory.distill` or the `--remember` CLI flag. */
export const DEFAULT_MEMORY_MODE = "disabled";
/** Directory permission for `~/.quanta/memory/`. Distilled knowledge is
 *  sensitive (preference signals, code excerpts, naming). Restrict to
 *  user. Applied on ensure-dir; not re-applied if dir already exists
 *  with permissive mode (caller's responsibility to fix). */
export const MEMORY_DIR_MODE = 0o700;
// Layering note (RFC §3.1): `@/memory` may only depend on `@/storage` +
// `@/shared`, NOT on `@/observability`. This file previously re-exported
// `QUANTA_ATTRS.memory.*` telemetry attribute keys (MEMORY_PHASE1_*_KEY /
// MEMORY_PHASE2_*_KEY) purely as stable local aliases. They had ZERO consumers
// in src/ or tests/ (the only mention was a comment in phase1.ts), so the alias
// import was a pure layering violation with no behavioral payload. Removed.
//
// The canonical OTel keys still live in `src/observability/vocabulary.ts`
// (`QUANTA_ATTRS.memory.phase1.*` / `.phase2.*`) and remain the single source
// of truth; any future telemetry emission belongs in the observability layer
// (or an emitter wired via `attrs.ts`), which is where it can reference the
// vocabulary without inverting the dependency direction.
