/**
 * ADR-0394 / RFC-06 A4.3 — objective-store composition wire (extracted from
 * `agent-config-assembler.ts` to keep that aggregator under the god-module line
 * cap; behavior byte-identical to the inlined `maybeWireObjective`).
 *
 * Wires the in-memory `ObjectivePort` that backs the `objective_*` LLM tools AND
 * the loop's derived-status consumers (`objectiveBudgetExhausted`,
 * `markObjectiveUsageLimitedFrom429`). The store's `enforceBudget` is resolved
 * from the SAME `QUANTA_OBJECTIVE_BUDGET_ENFORCE` gate those consumers read, so
 * the derived `usage_limited` / `budget_limited` states can actually surface in
 * prod when the operator opts in. Default-OFF ⇒ informational store ⇒
 * byte-identical.
 */

import type { AgentConfig } from "@/agent"
import type { RunLedgerPort } from "@/agent/run-ledger"
import { asObjectiveAuthority, type ObjectiveLifecycleSink, type ObjectivePort } from "@/objective"
import {
  buildObjectiveAuthority,
  createRegistryBlockerDependencyResolver,
  decodeObjectiveSnapshot,
  encodeObjectiveSnapshot,
} from "@/runner/assemble/session-authorities"
import { type PersistedObjectiveSnapshot, updateSessionAtomic } from "@/session"
import { gateOn } from "@/shared"
import type { TaskRegistry } from "@/subagent"

/** Minimal env view — same record shape the assembler threads everywhere. */
type Env = Record<string, string | undefined>

/**
 * RFC-03 H1 — resolve THE ONE gated objective authority for a surface, reading
 * the SAME three gates every objective consumer honors:
 *
 *   - `QUANTA_OBJECTIVE_TOOLS` OFF ⇒ `undefined` (NO authority ⇒ `config.objective`
 *     stays unset ⇒ `buildObjectiveBlock` composes NO `objective_*` tools; the
 *     `objective_set` tool-surface SSOT default is `cli: "opt-in"`). This is the
 *     strict opt-in the manifest promises.
 *   - `QUANTA_PROPOSE_GOAL` ⇒ `gateOn`: ON ⇒ every model-originated
 *     set/replace/completion is mediated (an admitted approval receipt is
 *     required; the objective tool adapter awaits the confirm port BETWEEN
 *     `prepare` and `commit`, no store lock across the wait). OFF ⇒ byte-identical
 *     legacy (model mutations commit without approval).
 *   - `confirmationAvailable` — the SURFACE's static confirm capability. Under the
 *     gate a surface that CANNOT raise an approval dialog is FAIL-CLOSED
 *     (`approval-unavailable` ⇒ the mutation is refused), NEVER an approval bypass.
 *   - `QUANTA_OBJECTIVE_BUDGET_ENFORCE` ⇒ `enforceBudget`: OFF ⇒ the store never
 *     derives usage_limited/budget_limited (informational store, byte-identical).
 *
 * Unlike {@link maybeWireObjective} (per-turn, `cfg`-mutating, derives
 * `confirmationAvailable` from `cfg.onConfirm`), this RETURNS the value so a
 * surface that owns a SESSION-STABLE instance (the CLI `/goal` core-state; the
 * web-daemon observability wire) can construct it ONCE and hand the SAME object to
 * BOTH `config.objective` (the LLM tools, adopted verbatim by
 * `maybeWireObjective`'s caller-override) AND its own consumers (the CLI slash +
 * idle ticker + status chip; the web objective emitter) — one authority per
 * surface, no split-brain, no per-turn re-mint that would drop the goal.
 */
export const resolveGatedObjectiveAuthority = (
  env: Env,
  opts: {
    readonly confirmationAvailable: boolean
    /** RFC-03 C2 — durable resume: the objective snapshot loaded from the
     *  reopened session's `SavedSession.objective`. When present it is decoded
     *  and restored VERBATIM at construction (ids / revision / provenance
     *  preserved; forged completions fail-closed on decode). Absent ⇒ a fresh
     *  empty authority (byte-identical legacy). */
    readonly restoreFrom?: PersistedObjectiveSnapshot | undefined
    /** Existing session registry providers. They are read lazily so a later
     * observability wire can bind its canonical ledger without rebuilding the
     * objective authority. */
    readonly runLedger?: (() => RunLedgerPort | undefined) | undefined
    readonly taskRegistry?: (() => TaskRegistry | undefined) | undefined
    readonly lifecycleSink?: ObjectiveLifecycleSink | undefined
  },
): ObjectivePort | undefined => {
  if (!gateOn(env, "QUANTA_OBJECTIVE_TOOLS")) return undefined
  const enforceBudget = gateOn(env, "QUANTA_OBJECTIVE_BUDGET_ENFORCE")
  const gateProposal = gateOn(env, "QUANTA_PROPOSE_GOAL")
  const blockerDependencyResolver =
    opts.runLedger === undefined && opts.taskRegistry === undefined
      ? undefined
      : createRegistryBlockerDependencyResolver({
          ...(opts.runLedger !== undefined ? { runLedger: opts.runLedger } : {}),
          ...(opts.taskRegistry !== undefined ? { tasks: opts.taskRegistry } : {}),
        })
  // RFC-03 C2 — construct through the ONE objective-authority builder (assembly
  // owns lifetime/restore), never a surface-local `createObjectiveStore()`. A
  // present `restoreFrom` rebuilds a byte-equivalent authority from the reopened
  // session; absent ⇒ fresh empty (default-OFF byte-identical).
  return buildObjectiveAuthority({
    ...(enforceBudget ? { enforceBudget: true } : {}),
    ...(gateProposal ? { gateOn: true, confirmationAvailable: opts.confirmationAvailable } : {}),
    ...(opts.restoreFrom !== undefined ? { restoreFrom: opts.restoreFrom } : {}),
    ...(blockerDependencyResolver !== undefined ? { blockerDependencyResolver } : {}),
    ...(opts.lifecycleSink !== undefined ? { lifecycleSink: opts.lifecycleSink } : {}),
  })
}

/**
 * RFC-03 C2 — build the LAZY objective-snapshot provider the per-turn save
 * (`persistTurn`) attaches to the durable `SavePayload`. Encodes the live
 * objective authority into its persisted DTO on demand (once per id-mode save),
 * so the goal / criterion-ids / revision / provenance survive a real `--resume`.
 *
 * `objective` is the base's slice-opaque `ObjectivePort` slot (typed `unknown`
 * on `RuntimeBase` so the host layer never value-couples to the domain). ABSENT
 * (no authority ⇒ `QUANTA_OBJECTIVE_TOOLS` off, or a surface with no goal wire)
 * ⇒ `undefined` ⇒ `persistTurn` omits the field ⇒ the store PRESERVES any
 * on-disk snapshot and the write is byte-identical (default-OFF). This is the
 * ONE place the encode adapter is reached on the save path.
 */
export const buildObjectiveSnapshotProvider = (
  objective: unknown,
): (() => PersistedObjectiveSnapshot | undefined) | undefined => {
  if (objective === undefined || objective === null) return undefined
  const port = objective as ObjectivePort
  return () => encodeObjectiveSnapshot(port)
}

/**
 * RFC-03 C2 (web parity) — FIRST-HYDRATE ONLY: restore a persisted objective snapshot INTO an already
 * live, session-stable authority at HYDRATE time (the DECODE mirror of
 * {@link buildObjectiveSnapshotProvider}'s encode). The web daemon mints ONE
 * objective authority per session, BEFORE any thread id is known, so it cannot use
 * the construction-time `restoreFrom` seam the CLI does; when a persisted thread is
 * reopened its durable goal must be planted into the live authority here.
 *
 * `authority` is the base's slice-opaque `ObjectivePort` slot (`runtime.objectiveAuthority`).
 * ABSENT (`QUANTA_OBJECTIVE_TOOLS` off ⇒ no authority) or an ABSENT snapshot (a
 * thread that never had an objective — `SavedSession.objective` is optional) ⇒ a
 * no-op (byte-identical default-OFF; no empty-goal fabrication). Malformed/forged
 * completions fail-closed inside `decodeObjectiveSnapshot` (unchanged).
 *
 * RE-KEY (`liveKey`) — the load-bearing web-daemon fix: the web daemon reads its
 * objective under `config.sessionId` === `base.sessionId`, a FRESH per-boot
 * `crypto.randomUUID()` (the daemon builds one session with no id, so `ensureSessionId`
 * mints a new one each restart). The persisted snapshot is keyed by the SAVING
 * boot's id, which can NEVER equal the reopening boot's read key — so planting the
 * domain under its own persisted threadId is inert (the model reads a different
 * key). When `liveKey` is supplied, the persisted goal is re-keyed onto it (the
 * reopening session's live objective read key, `sharedSession.sessionId`) so the
 * reopened turns actually see the goal. The web daemon holds exactly ONE per-session
 * objective domain (keyed by that single session id), so the snapshot carries one
 * domain to re-key; no-clobber guards initial hydration. Explicit thread attach
 * MUST use `prepareObjectiveSnapshotForAttach`, which replaces. Without
 * `liveKey` (non-web callers) each domain is planted VERBATIM under its own thread,
 * skipping any thread already live.
 */
export const restoreObjectiveSnapshotInto = (
  authority: unknown,
  snapshot: PersistedObjectiveSnapshot | undefined,
  liveKey?: string,
): void => {
  if (authority === undefined || authority === null || snapshot === undefined) return
  const auth = asObjectiveAuthority(authority as ObjectivePort)
  const domains = decodeObjectiveSnapshot(snapshot)
  if (liveKey !== undefined && liveKey !== "") {
    // Web daemon: re-key the (single) persisted domain onto the live read key so
    // the reopening boot's turns read it. No-clobber a goal already live on liveKey.
    if (auth.readDomain(liveKey).state !== null) return
    for (const domain of domains) auth.restoreDomain({ ...domain, threadId: liveKey })
    return
  }
  for (const domain of domains) {
    // No-clobber: never overwrite a thread the live session already holds.
    if (auth.readDomain(domain.threadId).state !== null) continue
    auth.restoreDomain(domain)
  }
}

export interface PreparedObjectiveAttach {
  readonly commit: () => boolean
}

export type PrepareObjectiveAttachResult =
  | { readonly ok: true; readonly prepared: PreparedObjectiveAttach }
  | { readonly ok: false; readonly reason: "invalid-objective-snapshot" }

/** Validate an explicit attach snapshot without mutating the live authority.
 * The returned commit replaces (including clears) the live key and therefore
 * must only run after transcript replacement and persistence repoint succeed. */
export const prepareObjectiveSnapshotForAttach = (
  authority: unknown,
  snapshot: PersistedObjectiveSnapshot | undefined,
  liveKey: string,
  previousLiveKey?: string,
): PrepareObjectiveAttachResult => {
  if (liveKey.length === 0) return { ok: false, reason: "invalid-objective-snapshot" }
  if (snapshot !== undefined) {
    const rawIds = snapshot.threads.map((thread) => thread.threadId)
    if (rawIds.length > 1 || new Set(rawIds).size !== rawIds.length || rawIds.some((id) => !id)) {
      return { ok: false, reason: "invalid-objective-snapshot" }
    }
  }
  const domains = snapshot === undefined ? [] : decodeObjectiveSnapshot(snapshot)
  if (
    domains.length > 1 ||
    (snapshot !== undefined && domains.length !== snapshot.threads.length)
  ) {
    return { ok: false, reason: "invalid-objective-snapshot" }
  }
  if (authority === undefined || authority === null) {
    return { ok: true, prepared: { commit: () => true } }
  }
  const auth = asObjectiveAuthority(authority as ObjectivePort)
  const persistedDomain = domains[0] ?? null
  return {
    ok: true,
    prepared: {
      commit: () =>
        auth.replaceDomainForAttach({
          liveThreadId: liveKey,
          ...(previousLiveKey !== undefined ? { previousLiveThreadId: previousLiveKey } : {}),
          persistedDomain,
        }).ok,
    },
  }
}

/**
 * GOAL-04 — persist the live objective snapshot ALONE (no transcript change),
 * used to make a `beginAttempt` reservation durable BEFORE the paid provider
 * call. Id-mode only: without a persisted session there is nothing durable to
 * write (the caller treats "no id" as no persistence requirement).
 */
export const persistObjectiveSnapshotNow = async (
  objective: unknown,
  sessionId: string | undefined,
): Promise<void> => {
  const provider = buildObjectiveSnapshotProvider(objective)
  if (provider === undefined || sessionId === undefined) return
  const snapshot = provider()
  if (snapshot === undefined) return
  const written = await updateSessionAtomic(sessionId, (saved) => ({
    ...saved,
    objective: snapshot,
  }))
  if (!written)
    throw new Error(`session ${sessionId} is not persisted; objective start not durable`)
}

/**
 * Opt-in objective-store wire. No-op unless `QUANTA_OBJECTIVE_TOOLS` is on
 * (shared assembler — bench/eval + web-daemon must stay byte-identical unless
 * they opt in; the CLI host seeds the gate). Caller-override-precedence
 * (ADR-0332): a pre-set slot is preserved (regardless of gate — a surface that
 * already threaded its SESSION-STABLE gated authority down on `base.objective`
 * keeps it; the assembler never clobbers a caller value). `confirmationAvailable`
 * is derived from the per-turn `cfg.onConfirm`, which the composition sets before
 * the objective tools execute; when it is absent the authority stays fail-closed
 * and the tool adapter's own `ctx.requestObjectiveApproval` presence check
 * backstops it at execute time.
 */
export const maybeWireObjective = (cfg: AgentConfig, env: Env): void => {
  const slot = cfg as AgentConfig & { objective?: ObjectivePort }
  if (slot.objective !== undefined) return
  const authority = resolveGatedObjectiveAuthority(env, {
    confirmationAvailable: cfg.onConfirm !== undefined,
  })
  if (authority !== undefined) slot.objective = authority
}
