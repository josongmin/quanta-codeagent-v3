/**
 * Hydrating wrapper around the in-memory {@link BackgroundSubagentScheduler}
 * (ADR-0158 Phase 1).
 *
 * Wraps an existing ADR-0130 scheduler instance with:
 *   1. On construction: load ALL handles from the store for `workspace`,
 *      classify by liveness — any persisted `"running"` handle whose
 *      `hostPid` is dead becomes `"interrupted"` AND the store is updated
 *      so the next process sees the corrected arm.
 *   2. Save-on-event: every `fork()` / `cancel()` AND every runner-result
 *      transition (success/failure) ALSO writes through to the store.
 *   3. New `"interrupted"` arm: `poll(id)` returns the interrupted snapshot;
 *      `await(id)` resolves immediately with it; `cancel(id)` returns
 *      `false` (no live handle to cancel); `list()` surfaces them sorted
 *      alongside live + terminal entries.
 *
 * Plane-clean: imports `../subagent-background` (port + types) and `./types`.
 * NO `@/agent/loop`, `@/agent/dispatch`, `@/llm`, `@/permission`, `@/tool`.
 *
 * Phase 1 is HONESTY: an interrupted handle is observable as "this work
 * died, here's its last-known state". Phase 2 (resume by re-binding a
 * runner to the persisted spec) is a separate ADR.
 */

import type {
  BackgroundSubagentScheduler,
  SubagentHandleId,
  SubagentResult,
  SubagentSpec,
  SubagentStatus,
} from "../subagent-background"
import {
  type PersistedHandle,
  type PersistedSubagentStatus,
  PersistenceError,
  type PersistentSchedulerStore,
} from "./types"

export interface HydratingSchedulerOpts {
  /** The in-memory ADR-0130 scheduler we wrap. The wrapper does NOT mutate
   *  the inner's behavior — it delegates all live operations to it. */
  readonly inner: BackgroundSubagentScheduler
  /** Closed-port store (jsonl adapter or a test fake). */
  readonly store: PersistentSchedulerStore
  /** Workspace fingerprint — scopes hydration + save metadata. */
  readonly workspace: string
  /** Test seam: how to check if a PID is alive. Default impl uses
   *  `process.kill(pid, 0)` and catches ESRCH. */
  readonly isProcessAlive?: (pid: number) => boolean
  /** Test seam: clock. Default `Date.now`. */
  readonly now?: () => number
  /** Test seam: host PID to embed into persisted handles. Default
   *  `process.pid`. */
  readonly hostPid?: () => number
  /** OPTIONAL (INV-09/INV-10 — jul-14 resume-depth-preservation) the REAL
   *  lineage depth every background child forked through this wrapper runs at
   *  (= the inner scheduler's construction-time `parentDepth + 1`, 0 = root).
   *  When present it is written onto every persisted `PersistedHandle.depth` so
   *  a later resume can enforce that the re-forked child does NOT gain spawn
   *  authority by being re-derived to a shallower depth. Every child forked by
   *  ONE wrapper shares this depth (the inner scheduler's parentDepth is fixed
   *  at its construction). ABSENT ⇒ `handle.depth` is OMITTED (backward
   *  compatible / legacy record — the resume guard treats it as fail-closed). A
   *  non-integer / negative value is OMITTED (defense-in-depth; the codec
   *  fail-closes such values on read too). */
  readonly childDepth?: number
  /** OPTIONAL out-of-band observability sink (DI observer). The store's
   *  `save` throws a typed {@link PersistenceError} `"io-failed"` on real disk
   *  failure — a signal the caller is meant to branch on. This scheduler
   *  swallows that signal at every write-catch site to keep the hot path quiet
   *  and non-wedging; when a sink is injected, it ALSO hands the (already
   *  swallowed) error out-of-band so the host can alert on lost crash/resume
   *  snapshots.
   *
   *  Contract:
   *   - Invoked AFTER the swallow — NEVER rethrown into the live loop, NEVER
   *     makes `fork()` async.
   *   - `critical: true` marks a discoverable-handle loss (fork-immediate,
   *     terminal completion/cancel, `forceBackground` promotion) — the host may
   *     want to alert loudly. `critical: false` marks a routine miss (hydration
   *     write-through / intermediate transition) that self-heals on the next
   *     save.
   *   - Absent ⇒ byte-identical to the current swallow (default-OFF).
   *   - A throwing host callback is defensively guarded here so it cannot
   *     re-wedge the write chain. */
  readonly onPersistError?: (
    err: PersistenceError,
    ctx: {
      readonly id: SubagentHandleId
      readonly phase: "hydrate-writethrough" | "save-on-event"
      readonly critical: boolean
    },
  ) => void
}

export type HydratedSubagentStatus = SubagentStatus | PersistedSubagentStatus

export interface HydratedSubagentResult extends Omit<SubagentResult, "status"> {
  readonly status: HydratedSubagentStatus
}

export interface PersistentBackgroundSubagentScheduler
  extends Omit<BackgroundSubagentScheduler, "poll" | "await" | "list"> {
  poll(id: SubagentHandleId): HydratedSubagentResult | null
  await(
    id: SubagentHandleId,
    awaitOpts?: { signal?: AbortSignal },
  ): Promise<HydratedSubagentResult | null>
  list(): ReadonlyArray<{
    id: SubagentHandleId
    result: HydratedSubagentResult
    spec: SubagentSpec
  }>
  /** Evict a single handle from the in-memory interrupted / hydrated caches.
   *  Call this after an external actor (e.g. `resumeInterruptedHandles`) writes
   *  a non-interrupted status for an id directly to the store — so that a
   *  subsequent `list()` / `poll()` no longer surfaces the stale "interrupted"
   *  snapshot. No-op when the id is unknown. */
  evictInterrupted(id: SubagentHandleId): void
}

/** Default liveness probe — `process.kill(pid, 0)` succeeds if the process
 *  exists AND the caller has permission to signal it; throws ESRCH when
 *  the process is gone. We treat any throw (incl. EPERM) as "alive" because
 *  EPERM means the process exists but we can't signal it. */
const defaultIsProcessAlive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e: unknown) {
    const code = (e as { code?: string } | null)?.code
    if (code === "EPERM") return true // exists, not signalable
    return false // ESRCH or anything else ⇒ assume dead
  }
}

/* ------------------------------------------------------------------ */
/* shape projections                                                   */
/* ------------------------------------------------------------------ */

/** Project an in-memory live `SubagentResult` to a `PersistedHandle` for the
 *  store. Optional fields OMITTED when absent (exactOptionalPropertyTypes).
 *  `hostPid` + `workspace` come from the wrapper config. */
const liveToPersisted = (
  id: SubagentHandleId,
  spec: SubagentSpec,
  result: SubagentResult,
  hostPid: number,
  workspace: string,
  childDepth: number | undefined,
): PersistedHandle => ({
  id,
  spec,
  status: result.status,
  startedAt: result.startedAt,
  turns: result.turns,
  outputSummary: result.outputSummary,
  ...(result.endedAt !== undefined ? { endedAt: result.endedAt } : {}),
  ...(result.outputDetail !== undefined ? { outputDetail: result.outputDetail } : {}),
  ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
  hostPid,
  workspace,
  // INV-09/INV-10 lineage capture. OMITTED when absent (legacy record) or when
  // the injected value is not a non-negative integer (defense-in-depth; the
  // codec fail-closes such values on read anyway).
  ...(childDepth !== undefined && Number.isInteger(childDepth) && childDepth >= 0
    ? { depth: childDepth }
    : {}),
})

/** Reclassify a persisted `"running"` handle whose PID is gone (or never
 *  set) into `"interrupted"`. Sets a terminal-ish `endedAt = now()` and a
 *  short error message. */
const reclassifyAsInterrupted = (h: PersistedHandle, tNow: number): PersistedHandle => ({
  ...h,
  status: "interrupted",
  endedAt: tNow,
  errorMessage: h.errorMessage ?? "interrupted: host process not alive at hydrate",
  outputSummary: h.outputSummary.length > 0 ? h.outputSummary : "(interrupted)",
})

/** Convert a persisted handle into the external `SubagentResult` shape so
 *  poll/await on an interrupted handle still surfaces a deterministic
 *  snapshot. We faithfully reflect "interrupted" as an extended-status
 *  field on the returned object; consumers that only know the 4 base arms
 *  see `status === "interrupted"` as an unknown string but the rest of the
 *  fields are present. */
const persistedToResult = (h: PersistedHandle): HydratedSubagentResult => ({
  // Persistence extends the live 4-arm lifecycle with `"interrupted"` and
  // `"resumed"`. Surface that honestly on the wrapper rather than narrowing
  // it back to the base scheduler's 4-arm type.
  status: h.status,
  outputSummary: h.outputSummary,
  startedAt: h.startedAt,
  turns: h.turns,
  ...(h.outputDetail !== undefined ? { outputDetail: h.outputDetail } : {}),
  ...(h.errorMessage !== undefined ? { errorMessage: h.errorMessage } : {}),
  ...(h.endedAt !== undefined ? { endedAt: h.endedAt } : {}),
})

/* ------------------------------------------------------------------ */
/* factory                                                             */
/* ------------------------------------------------------------------ */

export const persistentBackgroundSubagentScheduler = async (
  opts: HydratingSchedulerOpts,
): Promise<PersistentBackgroundSubagentScheduler> => {
  const { inner, store, workspace } = opts
  const isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive
  const now = opts.now ?? Date.now
  const hostPidFn = opts.hostPid ?? ((): number => process.pid)
  const childDepth = opts.childDepth
  const onPersistError = opts.onPersistError

  /** Surface an already-SWALLOWED save failure out-of-band. Normalizes the
   *  caught value to a {@link PersistenceError} (the store contract only
   *  promises that type; a stray throwable is wrapped rather than filtered into
   *  a second silent swallow) and hands it to the injected sink. Absent sink ⇒
   *  no-op (default-OFF, byte-identical). The sink call is defensively
   *  try-guarded so a throwing host callback cannot re-wedge the write chain or
   *  escape into the live loop. */
  const emitPersistError = (
    caught: unknown,
    id: SubagentHandleId,
    phase: "hydrate-writethrough" | "save-on-event",
    critical: boolean,
  ): void => {
    if (onPersistError === undefined) return
    const err =
      caught instanceof PersistenceError
        ? caught
        : new PersistenceError(
            "io-failed",
            `save ${id}: ${caught instanceof Error ? caught.message : String(caught)}`,
          )
    try {
      onPersistError(err, { id, phase, critical })
    } catch {
      // Defensive: a throwing host sink must NOT re-wedge the chain nor escape
      // into the live loop. The observability call is best-effort by design.
    }
  }

  /** Cache of HYDRATED-INTERRUPTED handles. These are NOT in `inner` (it has
   *  no entry for them — the original process died). The wrapper synthesizes
   *  poll/await/list responses from this map. */
  const interruptedById = new Map<SubagentHandleId, PersistedHandle>()
  /** Cache of every hydrated handle (interrupted + terminal) so `list()` can
   *  merge them with the inner's live view. Keyed by id; insertion order is
   *  not load-bearing (sort is by startedAt DESC inside `list`). */
  const hydratedById = new Map<SubagentHandleId, PersistedHandle>()

  /* ---- 1. Hydration ---- */
  const tHydrate = now()
  const persisted = await store.list(workspace)
  for (const h of persisted) {
    if (h.status === "running") {
      const alive = h.hostPid !== undefined && isProcessAlive(h.hostPid)
      if (!alive) {
        const fixed = reclassifyAsInterrupted(h, tHydrate)
        interruptedById.set(fixed.id, fixed)
        hydratedById.set(fixed.id, fixed)
        // Best-effort write-through so the next process sees "interrupted".
        // io-failed should not abort hydration — surface as a swallowed
        // miss; the next save-on-event will retry.
        try {
          await store.save(fixed)
        } catch (e) {
          // intentional swallow — hydration must remain best-effort. Surface
          // the (typed) failure out-of-band so the host can alert; a dropped
          // write here self-heals on the next save, so it is NON-critical.
          emitPersistError(e, fixed.id, "hydrate-writethrough", false)
        }
        continue
      }
      // PID still alive → the original process owns the work; we keep the
      // running snapshot in hydratedById for list() visibility but do NOT
      // try to revive a Promise we don't have.
      hydratedById.set(h.id, h)
      continue
    }
    // Terminal already (completed/failed/cancelled/interrupted).
    hydratedById.set(h.id, h)
  }

  /* ---- 2. Save-on-event helpers ---- */
  /** Per-handle write serializer. The fork-time "running" snapshot and the
   *  completion/cancel terminal snapshot are BOTH scheduled fire-and-forget;
   *  with the append-only / last-line-wins store, a runner that settles
   *  synchronously (cached/sync-resolved, or a cancel that flips the inner to
   *  terminal in-line) could otherwise let the terminal `store.save` land
   *  BEFORE the running `store.save`, persisting a FINISHED handle as
   *  `status:"running"` — a zombie on the next hydrate.
   *
   *  We establish a happens-before edge per id by chaining each write onto the
   *  previous one (`lastWrite = lastWrite.then(...)`). The PROJECTION is
   *  captured SYNCHRONOUSLY at enqueue time (so the running snapshot reflects
   *  the live state at enqueue, not whatever the inner has progressed to by the
   *  time the chain drains), while only the `store.save` I/O is serialized.
   *  A rejected link MUST NOT wedge the chain: every link catches its own
   *  error so the next save still runs. */
  const lastWriteById = new Map<SubagentHandleId, Promise<void>>()

  const saveLiveHandle = (id: SubagentHandleId, critical: boolean): Promise<void> => {
    // Capture the snapshot NOW so ordering is decided by enqueue order, not by
    // when the serialized chain happens to drain.
    const liveList = inner.list()
    const entry = liveList.find((e) => e.id === id)
    if (entry === undefined) {
      // Nothing live to persist for this id (already pruned/unknown). Return
      // the existing tail so callers can still await a stable point.
      return lastWriteById.get(id) ?? Promise.resolve()
    }
    const handle = liveToPersisted(id, entry.spec, entry.result, hostPidFn(), workspace, childDepth)

    const prev = lastWriteById.get(id) ?? Promise.resolve()
    const next = prev.then(async () => {
      try {
        await store.save(handle)
      } catch (e) {
        // intentional swallow on save-on-event — losing one snapshot must not
        // crash the live loop NOR wedge later writes on this id. The next
        // transition (or shutdown snapshot) will retry, AND the contract on
        // `PersistenceError("io-failed")` is the SURFACE owner's call to
        // log/alert. Phase 1 keeps the hot path quiet — but ALSO surfaces the
        // typed signal out-of-band via the injected sink (absent ⇒ no-op).
        emitPersistError(e, id, "save-on-event", critical)
      }
      // Once persisted to disk, also remove from the wrapper's hydrated cache
      // so list() doesn't show the stale snapshot beside the fresh inner view.
      hydratedById.delete(id)
    })
    lastWriteById.set(id, next)
    return next
  }

  /** Schedule a save-on-runner-completion poll. Called after fork(): we
   *  watch the inner via `await(id)` which resolves when the runner settles.
   *  This is the ONLY place we write the terminal snapshot. */
  const watchToCompletion = (id: SubagentHandleId): void => {
    void inner.await(id).then(
      async () => {
        // Terminal snapshot — a lost terminal write leaves a discoverable-handle
        // gap (re-hydrates as "running"), so this is CRITICAL.
        await saveLiveHandle(id, true)
      },
      async () => {
        // inner.await never rejects (see subagent-background contract);
        // defense in depth.
        await saveLiveHandle(id, true)
      },
    )
  }

  /* ---- 3. Wrapper surface ---- */
  return {
    fork(spec): SubagentHandleId {
      // inner.fork can throw on cap-exceeded — we propagate (saves only on
      // success).
      const id = inner.fork(spec)
      // Immediately save the running snapshot so a crash before completion
      // still leaves a discoverable handle. Losing THIS is the worst case (no
      // discoverable handle at all) ⇒ CRITICAL.
      void saveLiveHandle(id, true)
      watchToCompletion(id)
      return id
    },

    poll(id): HydratedSubagentResult | null {
      const live = inner.poll(id)
      if (live !== null) return live
      const interrupted = interruptedById.get(id)
      if (interrupted !== undefined) return persistedToResult(interrupted)
      const anyHydrated = hydratedById.get(id)
      if (anyHydrated !== undefined) return persistedToResult(anyHydrated)
      return null
    },

    async await(id, awaitOpts): Promise<HydratedSubagentResult | null> {
      const live = inner.poll(id)
      if (live !== null) return inner.await(id, awaitOpts)
      const interrupted = interruptedById.get(id)
      if (interrupted !== undefined) return persistedToResult(interrupted)
      const anyHydrated = hydratedById.get(id)
      if (anyHydrated !== undefined) return persistedToResult(anyHydrated)
      return null
    },

    cancel(id): boolean {
      const live = inner.poll(id)
      if (live !== null) {
        const ok = inner.cancel(id)
        // Terminal cancel snapshot — discoverable-handle transition ⇒ CRITICAL.
        if (ok) void saveLiveHandle(id, true)
        return ok
      }
      // Hydrated-interrupted / hydrated-terminal handles have no live
      // controller to cancel.
      return false
    },

    forceBackground(id, forceOpts) {
      // ADR-0487 — delegate to the inner scheduler's admission-queue promoter.
      // A promotion flips a `queued` handle to `running`; persist the fresh
      // live snapshot so a crash after promotion still leaves a discoverable
      // handle (mirrors `cancel`'s save-on-success). No-throw passthrough.
      const outcome = inner.forceBackground(id, forceOpts)
      if (outcome === "promoted_now" || outcome === "moved_to_front") {
        // Promotion is a discoverable-handle transition (queued → running) ⇒
        // CRITICAL.
        void saveLiveHandle(id, true)
      }
      return outcome
    },

    list(): ReadonlyArray<{
      id: SubagentHandleId
      result: HydratedSubagentResult
      spec: SubagentSpec
    }> {
      const liveEntries = inner.list()
      const liveIds = new Set(liveEntries.map((e) => e.id))
      const merged: Array<{
        id: SubagentHandleId
        result: HydratedSubagentResult
        spec: SubagentSpec
        startedAt: number
      }> = []
      for (const e of liveEntries) {
        merged.push({ id: e.id, result: e.result, spec: e.spec, startedAt: e.result.startedAt })
      }
      for (const [id, h] of hydratedById.entries()) {
        if (liveIds.has(id)) continue // inner wins for ids it knows
        merged.push({
          id,
          result: persistedToResult(h),
          spec: h.spec,
          startedAt: h.startedAt,
        })
      }
      merged.sort((a, b) => b.startedAt - a.startedAt)
      return merged.map(({ id, result, spec }) => ({ id, result, spec }))
    },

    prune(maxAgeMs): number {
      const removedLive = inner.prune(maxAgeMs)
      // Best-effort: trigger store prune in parallel; we don't await here
      // since the surface is sync. The count returned reflects in-memory
      // pruning only; the disk count surfaces via observability.
      void store.prune(workspace, maxAgeMs).catch(() => {
        // intentional swallow — disk prune failure is observability-only
      })
      // Also drop from hydrated cache anything that meets the cutoff so the
      // wrapper's `list()` stays consistent with the persistence layer.
      const cutoff = now() - Math.max(0, maxAgeMs)
      for (const [id, h] of hydratedById.entries()) {
        if (h.status === "running") continue
        const endedAt = h.endedAt ?? h.startedAt
        if (endedAt < cutoff) {
          hydratedById.delete(id)
          interruptedById.delete(id)
        }
      }
      return removedLive
    },

    serialize(): string {
      return inner.serialize()
    },

    hydrate(json): number {
      return inner.hydrate(json)
    },

    hydrateWithPrune(json, maxAgeMs): { restored: number; pruned: number } {
      return inner.hydrateWithPrune(json, maxAgeMs)
    },

    evictInterrupted(id: SubagentHandleId): void {
      interruptedById.delete(id)
      hydratedById.delete(id)
    },
  }
}

/** Re-exported so a caller composing the wrapper can branch on the 5th arm
 *  ("interrupted") without depending directly on the store types. */
export type { PersistedSubagentStatus }
