/**
 * `/rewind-tool` producer+consumer wire (ADR-0203 + ADR-0205).
 *
 * Builds a SESSION-SCOPED per-tool-checkpoint `GranularCheckpointPolicy`
 * (the `lookup`-bearing ADR-0203 registry — NOT the orthogonal ADR-0300
 * `GranularRegistryPort` content store) together with the matching
 * `ThreeWayRestorePort`, so the REPL surface can both (a) thread the policy
 * into `AgentConfig.shadowCheckpoint.granularPolicy` as the dispatch-wrap
 * PRODUCER and (b) feed the policy's `.registry` + the restore port into the
 * `/rewind-tool` slash CONSUMER (`buildReplSlashCtx` args `perToolRegistry` /
 * `perToolRestorePort`).
 *
 * # Default-OFF
 *
 * The composition root only calls this when `QUANTA_PER_TOOL_CHECKPOINT` is
 * truthy AND a shadow ODB exists. Absent ⇒ nothing is built, no AgentConfig
 * field is set, and `/rewind-tool` prints "not wired in this surface"
 * byte-identical.
 *
 * # Why a dedicated module
 *
 * Keeps the (policy, registry, restore-port) triple constructed in ONE place
 * so dispatch and the slash surface share the SAME registry instance (a fresh
 * instance per call — the prior blocker — would never accumulate anchors).
 *
 * # Slice discipline
 *
 * Reads ONLY `@/agent/checkpoint-policy`, `@/agent/per-tool-checkpoint`,
 * `@/agent/conversation-checkpoint` (task-leg store type), `@/storage`
 * (ShadowOdb). Does NOT import `@/agent/dispatch` / `@/agent/loop`.
 */

import { defaultCheckpointPolicy } from "@/agent/checkpoint-policy"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import {
  defaultGranularCheckpointPolicy,
  defaultThreeWayRestore,
  type GranularCheckpointPolicy,
  type GranularRegistry,
  type ThreeWayRestorePort,
} from "@/agent/per-tool-checkpoint"
import type { ShadowOdb } from "@/storage"

/** Inputs the composition root already has on hand at session-compose time. */
export interface PerToolCheckpointWireDeps {
  /** The env-gated shadow ODB (same instance the loop checkpoints into).
   *  REQUIRED — the files leg cannot rewind without it. */
  readonly shadowOdb: ShadowOdb
  /** Conversation store for the OPTIONAL task leg. When omitted, the task
   *  leg returns a typed `task-snapshot-missing` outcome and the files leg
   *  still works. */
  readonly conversationStore?: ConversationCheckpointStore | undefined
  /** Absolute workspace root the restore port rewinds against. */
  readonly workspace: string
}

/** The triple the surface threads into both the producer (AgentConfig) and
 *  the consumer (slash ctx). */
export interface PerToolCheckpointWire {
  /** Session-scoped granular policy — pass as the dispatch-wrap producer via
   *  `AgentConfig.shadowCheckpoint.granularPolicy`. Its `.registry` is the
   *  SAME instance surfaced below. */
  readonly policy: GranularCheckpointPolicy
  /** The `lookup`-bearing registry for the `/rewind-tool` `perToolRegistry`
   *  arg. Identical reference to `policy.registry`. */
  readonly registry: GranularRegistry
  /** The 3-way restore port for the `/rewind-tool` `perToolRestorePort` arg. */
  readonly restore: ThreeWayRestorePort
}

/** Build the per-tool-checkpoint producer+consumer triple. Pure / no I/O at
 *  construction time (mirrors `defaultThreeWayRestore`'s posture). */
export const buildPerToolCheckpointWire = (
  deps: PerToolCheckpointWireDeps,
): PerToolCheckpointWire => {
  // Base ADR-0121 policy in `per-mutating` mode: tool-grain anchors want an
  // anchor for EVERY destructive call (granular-policy.ts: tool-grain requires
  // the base mode to be per-mutating to anchor on each call). The wrap still
  // short-circuits when mode is "off".
  const base = defaultCheckpointPolicy({ mode: "per-mutating", odb: deps.shadowOdb })
  const policy = defaultGranularCheckpointPolicy({ base, granularity: "tool" })
  const restore = defaultThreeWayRestore({
    registry: policy.registry,
    workspace: deps.workspace,
    shadowOdb: deps.shadowOdb,
    ...(deps.conversationStore !== undefined ? { conversationStore: deps.conversationStore } : {}),
  })
  return { policy, registry: policy.registry, restore }
}
