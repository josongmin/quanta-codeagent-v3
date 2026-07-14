/**
 * Web SUBAGENT WS protocol — the out-of-band wire codec for the multi-agent
 * orchestration ("Sub-Agents") panel.
 *
 * FAITHFUL PARALLEL of `@/protocol/agent-state`'s wire codec
 * (`encodeAgentStateFrame` / `decodeAgentStateFrame`), but for the SUBAGENT
 * lifecycle channel: each `subagent_spawn` / `subagent_status`
 * {@link SubagentObservation} (already projected + registry-bounded upstream)
 * is carried out-of-band on the `QUANTA_WEB_SUBAGENTS` channel as a `subagent`
 * frame so the browser Sub-Agents panel can render the live spawn TREE.
 *
 * DEDICATED module (NOT folded into `@/protocol/agent-state`) so it is purely
 * ADDITIVE — the concurrent-shared agent-state codec is untouched. The read
 * model (`SubagentObservation`) is imported READ-ONLY from the frozen
 * `@/protocol/subagent` slice; this module owns ONLY the wire envelope + codec.
 *
 * Slice fence: `@/protocol/subagent-frame` value-imports nothing from
 * `@/stream` (the observation is fully formed) — only the type-only read model
 * from `@/protocol/subagent`.
 */

import type { SubagentObservation } from "@/protocol/subagent"

export type { SubagentObservation }

/** The message the `subagent` frame carries — the projected read model plus the
 *  universal `emittedAt` clock (mirrors the canvas / agent-state message shape,
 *  so any transport routing those frames routes these). */
export type SubagentMessage = SubagentObservation & { readonly emittedAt: number }

/** Wire envelope — mirrors the session / observability / canvas / agent-state
 *  `{ version, kind, payload }` shape. */
export interface SubagentWireEnvelope {
  readonly version: string
  readonly kind: "subagent"
  readonly payload: SubagentMessage
}

/** Pinned version tag — bumped on a backward-incompatible change. Decoupled
 *  from the session / observability / canvas / agent-state versions on purpose
 *  (a v2 emitter to a v1 consumer is rejected, not silently mis-rendered). */
export const SUBAGENT_PROTOCOL_VERSION = "subagent.v1" as const

/** Map a projected {@link SubagentObservation} onto the wire message (stamps
 *  the emit clock). Pure. `at` on the observation is the domain event time; the
 *  separate `emittedAt` is the wire-emit time, mirroring the other channels. */
export const subagentObservationToMessage = (
  observation: SubagentObservation,
  opts?: { readonly now?: number },
): SubagentMessage => ({ ...observation, emittedAt: opts?.now ?? Date.now() })

/** Encode a typed subagent message into a JSON wire frame. */
export const encodeSubagentFrame = (msg: SubagentMessage): string =>
  JSON.stringify({
    version: SUBAGENT_PROTOCOL_VERSION,
    kind: "subagent",
    payload: msg,
  } satisfies SubagentWireEnvelope)

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

/** Best-effort structural guard for a subagent message payload — tag
 *  (`subagent_spawn` / `subagent_status`) + the universal `emittedAt` + the
 *  load-bearing `taskId`, no deeper per-arm validation (unknown fields are
 *  forward-compatible). */
export const isSubagentMessage = (value: unknown): value is SubagentMessage => {
  if (!isRecord(value)) return false
  if (value.type !== "subagent_spawn" && value.type !== "subagent_status") return false
  if (typeof value.taskId !== "string" || value.taskId.length === 0) return false
  return typeof value.emittedAt === "number" && Number.isFinite(value.emittedAt)
}

/**
 * Decode a `subagent` wire frame into a typed message, or `null` on any shape
 * mismatch. Mirrors `decodeAgentStateFrame` — empty / missing / mismatched
 * version reject. NO-THROW: callers log + drop on null.
 */
export const decodeSubagentFrame = (raw: unknown): SubagentMessage | null => {
  if (typeof raw !== "string") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.kind !== "subagent") return null
  if (typeof parsed.version !== "string" || parsed.version.length === 0) return null
  // Gate the version we claim to carry: a v2 emitter to a v1 consumer would
  // otherwise be read with the wrong schema and silently mis-rendered.
  if (parsed.version !== SUBAGENT_PROTOCOL_VERSION) return null
  return isSubagentMessage(parsed.payload) ? parsed.payload : null
}
