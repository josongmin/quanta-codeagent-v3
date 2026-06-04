/**
 * H16 — `src/memory/dream/` barrel.
 *
 * CROSS-SESSION memory consolidation ("auto-dream"). GLUE on top of the
 * EXISTING consolidate pipeline (ADR-0068 `runPhase2`, ADR-0281 auto-trigger):
 * a persisted counter/clock fires the consolidator when N sessions OR H hours
 * have elapsed since the last dream, guarded by a dream-lock, writing to a
 * SEPARATE `team/` target (never the live `MEMORY.md`).
 *
 * Default-OFF: with no `DreamPolicy` (i.e. `QUANTA_AUTO_DREAM` unset) the
 * trigger never advances its counter, reads/writes no state, and fires no
 * consolidate — byte-identical to the pre-H16 path.
 */

export {
  CrossSessionDreamTrigger,
  type CrossSessionDreamTriggerOpts,
  type DreamLockPort,
  type DreamTelemetryPort,
  noopDreamTelemetry,
} from "./cross-session-trigger"
export { InMemoryDreamState } from "./in-memory-state"
export type {
  DreamConsolidatePort,
  DreamConsolidateResult,
  DreamStatePort,
  DreamWriteTargetPort,
} from "./port"
export {
  DREAM_TEAM_FILENAME,
  DREAM_TEAM_SUBDIR,
  type DreamFsPort,
  FileDreamWriteTarget,
  type FileDreamWriteTargetOpts,
  resolveDreamTeamPath,
} from "./team-write-target"
export {
  DEFAULT_DREAM_POLICY,
  DREAM_LOCK_KEY,
  DREAM_LOCK_TTL_MS,
  DreamError,
  type DreamErrorReason,
  type DreamOutcome,
  type DreamOutcomeKind,
  type DreamPolicy,
  type DreamState,
  INITIAL_DREAM_STATE,
} from "./types"
export {
  assembleDreamPolicy,
  type DreamConfigView,
  type DreamSlot,
} from "./wire"
