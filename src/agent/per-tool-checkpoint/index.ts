/**
 * Per-tool checkpoint slice — barrel.
 *
 * Surface:
 *   - {@link defaultGranularCheckpointPolicy} — ADR-0203 (per-tool granularity)
 *   - {@link defaultThreeWayRestore}          — ADR-0205 (3-way restore)
 *   - All port types from `./port` (`GranularCheckpointPolicy`,
 *     `ThreeWayRestorePort`, `RestoreOutcome`, `RestoreErrorCode`, …)
 *
 * # Default-OFF
 *
 * No code in this slice is wired into the loop. A consumer (assembly
 * layer / future slash command) opts in by constructing the policy via
 * `defaultGranularCheckpointPolicy` and the restore port via
 * `defaultThreeWayRestore`. Neither factory mutates any global state nor
 * spawns any I/O at construction time — the slice is byte-identical for
 * every legacy caller.
 *
 * # Slice discipline
 *
 * - Reads `@/storage/shadow-odb`        (port + error type)
 * - Reads `@/agent/checkpoint-policy`   (CheckpointPolicy port)
 * - Reads `@/agent/conversation-checkpoint` (store port)
 * - Reads `@/llm`                        (Message type)
 * - Reads `@/tool`                       (Tool / ToolContext types)
 *
 * Does NOT import:
 * - `@/agent/dispatch`, `@/agent/loop`, `@/agent/effect-channel`
 * - `@/permission`, `@/session`, `@/observability`, `@/apps/*`
 *
 * Those are the consumers, not the collaborators.
 */

export { defaultGranularCheckpointPolicy } from "./granular-policy"
export type {
  AnchorContext,
  CheckpointGranularity,
  CheckpointTag,
  GranularCheckpointEntry,
  GranularCheckpointPolicy,
  GranularCheckpointPolicyConfig,
  GranularRegistry,
  RestoreErrorCode,
  RestoreOptions,
  RestoreOutcome,
  ThreeWayRestorePort,
  ThreeWayRestorePorts,
} from "./port"
export { defaultThreeWayRestore } from "./three-way-restore"
