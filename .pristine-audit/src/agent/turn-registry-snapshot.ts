/**
 * Turn capability snapshot (RFC-04 / RFC04-0).
 *
 * WHAT
 * ────
 * A single immutable record that binds the concrete `ToolRegistry` (the ONLY
 * dispatch authority) to the model-visible `specs` and an origin/trust
 * `fingerprint` under ONE generation `id`. The point is a structural
 * guarantee: the specs advertised to the model and the registry used for
 * dispatch/admissibility are ALWAYS the same generation — they are derived
 * together in `buildTurnRegistrySnapshot`, so there is no code path that can
 * advertise generation-A specs while dispatching against generation-B tools.
 *
 * NON-OWNERSHIP
 * ─────────────
 * This record does NOT own tools, origin, dispatch, or collision logic —
 * `ToolRegistry` remains the concrete authority (README single-owner matrix:
 * "tool catalog/dispatch = ToolRegistry"). The snapshot is a consistency
 * record + a generation label, distinct from the `ToolSurface` product axis.
 * It stores no mutable state; a reload publishes a NEW snapshot, never mutates
 * an existing one.
 *
 * ATOMIC POINTER
 * ──────────────
 * `TurnRegistrySnapshotRef` is a read-only view over an atomically-swappable
 * pointer. A turn reads `current()` exactly once at its boundary and pins that
 * reference for the whole turn; a publish swaps the pointer for the NEXT turn.
 * The ref never exposes the mutable setter to turn code — only the host
 * reload controller (RFC04-2/3) holds the publish handle.
 */

import type { ToolRegistry } from "@/tool"
import type { ToolSpec } from "@/tool/types"

/** MCP protocol version pinned into a snapshot so a reload that negotiates a
 *  different protocol version publishes a distinguishable generation. Snapshots
 *  built without an MCP source (the default builtin-only turn) carry the
 *  sentinel below. */
export const NO_MCP_PROTOCOL_VERSION = "none"

/** Field separator inside one tool's fingerprint token (name<US>origin). */
const FP_FIELD = "\t"
/** Record separator between tool tokens in the joined fingerprint. */
const FP_RECORD = "\n"

/**
 * Immutable capability generation for one turn.
 *
 *  - `id` — monotonic generation label. Model specs, origin/trust, and
 *    dispatch all read the SAME id; a mixed-generation turn is impossible by
 *    construction (there is exactly one snapshot per turn).
 *  - `protocolVersion` — the negotiated MCP protocol version, or
 *    `NO_MCP_PROTOCOL_VERSION`.
 *  - `registry` — the concrete `ToolRegistry` authority. Dispatch/admissibility
 *    read tools/origin/run from HERE.
 *  - `specs` — the model-visible schema list, derived from THIS registry.
 *  - `fingerprint` — a deterministic digest of tool name+origin over THIS
 *    registry, so two snapshots are equal iff the advertised/dispatchable
 *    surface is equal (compare-and-publish key for the reload controller).
 */
export interface TurnRegistrySnapshot {
  readonly id: number
  readonly protocolVersion: string
  readonly registry: ToolRegistry
  /** The model-visible schema list derived from THIS `registry`. The array is a
   *  fresh `registry.specs()` result (mutable element type to match the
   *  existing `TurnSession.specs` contract); the RECORD is immutable (this slot
   *  cannot be reassigned), which is the generation invariant that matters. */
  readonly specs: ToolSpec[]
  readonly fingerprint: string
}

/**
 * Deterministic origin/trust fingerprint over a registry: `name<TAB>origin`
 * per tool in stable registry (insertion) order, joined by newlines. Two
 * registries with the same tool names AND the same per-tool origin produce the
 * same fingerprint; a reload that changes a tool's origin (e.g. a `builtin`
 * name shadowed by an `mcp` tool) changes the fingerprint even at equal names.
 * Pure over `registry.toolNames()`/`registry.originOf` — no name-guessing.
 */
export const fingerprintRegistry = (registry: ToolRegistry): string =>
  registry
    .toolNames()
    .map((name) => `${name}${FP_FIELD}${registry.originOf(name)}`)
    .join(FP_RECORD)

let nextSnapshotId = 0

/** Reset the module-global generation counter. TEST-ONLY: gives snapshot-id
 *  assertions a deterministic starting point. Never called by production code. */
export const __resetTurnRegistrySnapshotId = (): void => {
  nextSnapshotId = 0
}

/**
 * Build ONE snapshot binding `registry` to specs+fingerprint derived from that
 * SAME registry under a fresh generation id. Callers cannot supply a specs list
 * out of band — specs come from `registry.specs()` here, so the "advertise A,
 * dispatch B" divergence is unrepresentable.
 */
export const buildTurnRegistrySnapshot = (
  registry: ToolRegistry,
  opts?: { readonly protocolVersion?: string },
): TurnRegistrySnapshot => ({
  id: nextSnapshotId++,
  protocolVersion: opts?.protocolVersion ?? NO_MCP_PROTOCOL_VERSION,
  registry,
  specs: registry.specs(),
  fingerprint: fingerprintRegistry(registry),
})

/**
 * Read-only view over an atomically-swappable snapshot pointer. Turn code reads
 * `current()` once per turn boundary; the host reload controller holds the
 * separate `publish` handle from {@link createTurnRegistrySnapshotRef}.
 */
export interface TurnRegistrySnapshotRef {
  current(): TurnRegistrySnapshot
}

/**
 * Create an atomic snapshot pointer seeded with `initial`. Returns the
 * read-only `ref` (handed to turn bootstrap) and a `publish(next)` setter (held
 * ONLY by the host reload controller). The swap is a single pointer assignment;
 * a turn that already pinned `current()` keeps its reference across a publish.
 */
export const createTurnRegistrySnapshotRef = (
  initial: TurnRegistrySnapshot,
): {
  readonly ref: TurnRegistrySnapshotRef
  publish(next: TurnRegistrySnapshot): void
} => {
  let currentSnapshot = initial
  return {
    ref: { current: () => currentSnapshot },
    publish: (next) => {
      currentSnapshot = next
    },
  }
}
