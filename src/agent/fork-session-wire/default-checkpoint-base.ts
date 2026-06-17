/**
 * Default checkpoint-base wire (ADR-0284).
 *
 * Today the unified-agent surface constructs `defaultForker()` WITHOUT a
 * base `SessionForker` (see `src/apps/agent/index.ts` `resolveForkSession`),
 * which means every `fork()` call surfaces `Err("fork-not-configured")` —
 * the rich `ForkSessionPort` API is reachable but the actual fork is a
 * no-op. This wire closes that gap: it constructs a fresh
 * `ConversationCheckpointStore` and adapts it into a base `SessionForker`
 * so `defaultForker({ base })` actually clones snapshots.
 *
 * Plane-clean: imports only `@/agent/conversation-checkpoint` (the in-mem
 * store) + `@/agent/fork-session` (the base + rich port factories). NO
 * `@/agent/loop`, NO `@/agent/dispatch`, NO `@/llm`, NO `@/tool`.
 *
 * Default-OFF: nothing in this slice runs unless the host explicitly calls
 * {@link defaultCheckpointBaseWire}. The composition root gates the call on the
 * per-surface `forkSession` request flag (see `resolveForkSession` in
 * agent-arg-builder) — CLI REPL sets it via `maybeForkSession(args)`. There is
 * NO `QUANTA_FORK_SESSION` env var; the prior comment naming one was stale.
 *
 * Contracts (4):
 *   1. NO-THROW on the public surface for operational failures — every
 *      validation miss collapses to a typed Result via the wrapped
 *      ForkSessionPort.
 *   2. ISOLATION — each `defaultCheckpointBaseWire()` call mints a FRESH
 *      `ConversationCheckpointStore` so two surfaces never share a store
 *      by accident (parent isolation invariant).
 *   3. exactOptionalPropertyTypes — every optional field is OMITTED.
 *   4. SIGNAL PROPAGATION — the constructed `ForkSessionPort` already
 *      honours `signal` (per ADR-0226); the wire does not need to add a
 *      second cancellation layer.
 */

import {
  type ConversationCheckpointStore,
  defaultConversationCheckpointStore,
} from "@/agent/conversation-checkpoint"
import {
  defaultForker,
  defaultParentLinkStore,
  defaultSessionForker,
  type ForkSessionPort,
  type ParentLinkStore,
  type SessionForker,
  type ShadowOdbLike,
} from "@/agent/fork-session"

/** Tunables forwarded to the underlying store + forker. All optional. */
export interface CheckpointBaseWireOpts {
  /** Cap on the number of snapshots retained by the in-mem store. Default 50. */
  readonly maxEntries?: number
  /** Injected clock for `record`/`fork` timestamps. Default `Date.now`. */
  readonly now?: () => number
  /** Optional pre-built store. When present, the wire WRAPS it instead of
   *  minting a fresh one — useful when the host already has a store wired
   *  for another purpose (e.g. conversation rollback) and wants the
   *  fork-session to share it. Absent ⇒ fresh store. */
  readonly store?: ConversationCheckpointStore
  /** Optional parent-link store override. Defaults to a fresh
   *  `defaultParentLinkStore()`. */
  readonly links?: ParentLinkStore
  /** Optional shadow ODB adapter — best-effort fork-tag write. Absent ⇒
   *  shadow ODB tag is silently skipped (per ADR-0226 BEST-EFFORT contract). */
  readonly shadowOdb?: ShadowOdbLike
  /** Workspace root passed to `shadowOdb.registerHead`. Required when
   *  `shadowOdb` is wired. */
  readonly workspaceRoot?: string
}

/** Wired bundle returned by {@link defaultCheckpointBaseWire}. The host
 *  injects `forker` into `AgentConfig.forkSession` and keeps `store` /
 *  `base` references if it wants to record snapshots itself (e.g. on
 *  turn boundaries). */
export interface CheckpointBaseWire {
  /** The in-memory `ConversationCheckpointStore` snapshots are recorded into. */
  readonly store: ConversationCheckpointStore
  /** The base sync `SessionForker` adapter over `store`. */
  readonly base: SessionForker
  /** The rich `ForkSessionPort` ready to inject into `AgentConfig.forkSession`. */
  readonly forker: ForkSessionPort
}

/**
 * Build a default checkpoint-base wire. Stitches a
 * `ConversationCheckpointStore` (in-mem, default 50-entry LRU) +
 * `defaultSessionForker` (sync base) + `defaultForker` (rich port) +
 * optional `ParentLinkStore` / `ShadowOdbLike` into a single bundle
 * the composition root injects via `AgentConfig.forkSession`.
 *
 * Pure: no side-effects on call. The store is empty until the host calls
 * `store.record(...)` from outside this slice.
 */
export const defaultCheckpointBaseWire = (opts?: CheckpointBaseWireOpts): CheckpointBaseWire => {
  const store =
    opts?.store ??
    defaultConversationCheckpointStore({
      ...(opts?.maxEntries !== undefined ? { maxEntries: opts.maxEntries } : {}),
      ...(opts?.now !== undefined ? { now: opts.now } : {}),
    })
  const base: SessionForker = defaultSessionForker(store, {
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
  })
  const links = opts?.links ?? defaultParentLinkStore()
  const forker: ForkSessionPort = defaultForker({
    base,
    links,
    ...(opts?.shadowOdb !== undefined ? { shadowOdb: opts.shadowOdb } : {}),
    ...(opts?.workspaceRoot !== undefined ? { workspaceRoot: opts.workspaceRoot } : {}),
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
  })
  return { store, base, forker }
}
