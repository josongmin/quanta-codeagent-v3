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
} from "../subagent-background"
import type { PersistedHandle, PersistedSubagentStatus, PersistentSchedulerStore } from "./types"

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
const persistedToResult = (h: PersistedHandle): SubagentResult => ({
  // `SubagentResult.status` is typed as 4 base arms; we cast through unknown
  // because the persistence layer's surface is the 5-arm union and a
  // consumer expecting only base arms still gets a valid object whose
  // remaining fields it can read.
  status: h.status as unknown as SubagentResult["status"],
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
): Promise<BackgroundSubagentScheduler> => {
  const { inner, store, workspace } = opts
  const isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive
  const now = opts.now ?? Date.now
  const hostPidFn = opts.hostPid ?? ((): number => process.pid)

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
        } catch {
          // intentional swallow — hydration must remain best-effort
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
  const saveLiveHandle = async (id: SubagentHandleId): Promise<void> => {
    const liveList = inner.list()
    const entry = liveList.find((e) => e.id === id)
    if (entry === undefined) return
    const handle = liveToPersisted(id, entry.spec, entry.result, hostPidFn(), workspace)
    try {
      await store.save(handle)
    } catch {
      // intentional swallow on save-on-event — losing one snapshot must not
      // crash the live loop. The next transition (or shutdown snapshot) will
      // retry, AND the contract on `PersistenceError("io-failed")` is the
      // SURFACE owner's call to log/alert. Phase 1 keeps the hot path quiet.
    }
    // Once persisted to disk, also remove from the wrapper's hydrated cache
    // so list() doesn't show the stale snapshot beside the fresh inner view.
    hydratedById.delete(id)
  }

  /** Schedule a save-on-runner-completion poll. Called after fork(): we
   *  watch the inner via `await(id)` which resolves when the runner settles.
   *  This is the ONLY place we write the terminal snapshot. */
  const watchToCompletion = (id: SubagentHandleId): void => {
    void inner.await(id).then(
      async () => {
        await saveLiveHandle(id)
      },
      async () => {
        // inner.await never rejects (see subagent-background contract);
        // defense in depth.
        await saveLiveHandle(id)
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
      // still leaves a discoverable handle.
      void saveLiveHandle(id)
      watchToCompletion(id)
      return id
    },

    poll(id): SubagentResult | null {
      const live = inner.poll(id)
      if (live !== null) return live
      const interrupted = interruptedById.get(id)
      if (interrupted !== undefined) return persistedToResult(interrupted)
      const anyHydrated = hydratedById.get(id)
      if (anyHydrated !== undefined) return persistedToResult(anyHydrated)
      return null
    },

    async await(id, awaitOpts): Promise<SubagentResult | null> {
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
        if (ok) void saveLiveHandle(id)
        return ok
      }
      // Hydrated-interrupted / hydrated-terminal handles have no live
      // controller to cancel.
      return false
    },

    list(): ReadonlyArray<{
      id: SubagentHandleId
      result: SubagentResult
      spec: SubagentSpec
    }> {
      const liveEntries = inner.list()
      const liveIds = new Set(liveEntries.map((e) => e.id))
      const merged: Array<{
        id: SubagentHandleId
        result: SubagentResult
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
  }
}

/** Re-exported so a caller composing the wrapper can branch on the 5th arm
 *  ("interrupted") without depending directly on the store types. */
export type { PersistedSubagentStatus }
