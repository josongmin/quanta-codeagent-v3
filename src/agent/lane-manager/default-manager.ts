/**
 * Default lane-manager (ADR-0285).
 *
 * `Promise.allSettled`-shaped aggregation with:
 *   - per-lane child {@link DelegationRunnerPort} dispatch (injected),
 *   - parent `AbortSignal` cascade — abort ⇒ every in-flight lane fails
 *     with `error.kind="aborted"`,
 *   - `maxConcurrency` cap (default {@link DEFAULT_MAX_CONCURRENCY}) —
 *     over-cap lanes either QUEUE (default) or get rejected with
 *     `error.kind="concurrency-exceeded"` when `queueMode:"reject"` is
 *     selected,
 *   - per-call `timeoutMs` on `awaitAll` — stragglers force-cancel and
 *     surface `error.kind="timeout"`.
 *
 * Plane-clean: imports `@/agent/delegation-runner` (port type) and sibling
 * slice files only. NO `@/agent/loop`, NO `@/agent/dispatch`, NO `@/llm`,
 * NO `@/tool`.
 *
 * Order invariant: `awaitAll` returns results in HANDLE ORDER (input
 * position), NOT completion order. The hellgate seals this.
 */

import type { DelegationRunnerPort } from "@/agent/delegation-runner"
import { errMessage } from "@/shared"
import type { LaneManager } from "./port"
import {
  DEFAULT_MAX_CONCURRENCY,
  type LaneError,
  type LaneHandle,
  type LaneResult,
  type LaneSpec,
} from "./types"
export interface DefaultLaneManagerOpts {
  /** Injected runner — every lane dispatches its delegate spec through this
   *  port. The runner builds its own child agent (or stub). When absent,
   *  spawnLane returns a handle that resolves to `error.kind="spawn-failed"`
   *  so the host never gets a silent no-op. */
  readonly runner?: DelegationRunnerPort
  /** Parent abort signal. When fired, every in-flight lane is cancelled and
   *  surfaces `error.kind="aborted"`. Optional. */
  readonly signal?: AbortSignal
  /** Max concurrent lanes. Default {@link DEFAULT_MAX_CONCURRENCY}. */
  readonly maxConcurrency?: number
  /** Behaviour when `spawnLane` is called past `maxConcurrency`:
   *    - "queue"  (default): the lane is queued; runs when a slot frees.
   *    - "reject": the lane immediately resolves to
   *                `error.kind="concurrency-exceeded"`. */
  readonly queueMode?: "queue" | "reject"
  /** Injected clock for `durationMs`. Default `Date.now`. */
  readonly now?: () => number
}

/** Build a deterministic lane id — counter-based per manager. */
const makeIdMinter = (): (() => string) => {
  let n = 0
  return (): string => {
    n += 1
    return `lane-${String(n).padStart(4, "0")}`
  }
}

/** Project an internal AbortController into a lane error. */
const makeAbortError = (msg: string): LaneError => ({ kind: "aborted", message: msg })

/** Build the default lane manager. */
export const defaultLaneManager = (opts?: DefaultLaneManagerOpts): LaneManager => {
  const runner = opts?.runner
  const parentSignal = opts?.signal
  const maxConcurrency = Math.max(1, opts?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY)
  const queueMode = opts?.queueMode ?? "queue"
  const now = opts?.now ?? Date.now
  const mintId = makeIdMinter()

  // Running set + a FIFO queue for over-cap spawns when queueMode="queue".
  let running = 0
  const waiters: Array<() => void> = []

  const acquireSlot = async (): Promise<boolean> => {
    if (running < maxConcurrency) {
      running += 1
      return true
    }
    if (queueMode === "reject") return false
    // Queue: park the spawn until a sibling lane releases.
    await new Promise<void>((resolve) => waiters.push(resolve))
    running += 1
    return true
  }

  const releaseSlot = (): void => {
    running -= 1
    const next = waiters.shift()
    if (next !== undefined) next()
  }

  // Per-manager AbortController so we can fan out parent-signal abort to
  // every lane controller. The lane creates its OWN child controller chained
  // off this one, so cancellation propagates without leaking the parent
  // signal directly.
  const managerCtrl = new AbortController()
  if (parentSignal !== undefined) {
    if (parentSignal.aborted === true) managerCtrl.abort()
    else parentSignal.addEventListener("abort", () => managerCtrl.abort(), { once: true })
  }

  // Per-lane controllers, keyed by handle. Minted at spawn time so `awaitAll`
  // can FORCE-CANCEL a lane's delegate on timeout (the CASCADE contract) — the
  // controller is otherwise closure-local to `runLane` and unreachable from
  // `awaitAll`, which is exactly the delegate-leak the ADR-0285 timeout arm had.
  // A WeakMap keeps the public `LaneHandle` type clean (no cancel field leaks).
  const laneCtrls = new WeakMap<LaneHandle, AbortController>()

  const runLane = async (
    handle: LaneHandle,
    laneCtrl: AbortController,
    label: string | undefined,
  ): Promise<LaneResult> => {
    const startedAt = now()

    const acquired = await acquireSlot()
    if (!acquired) {
      const result: LaneResult = {
        id: handle.id,
        ok: false,
        error: {
          kind: "concurrency-exceeded",
          message:
            `lane '${handle.id}': spawn rejected — running=${running}, ` +
            `maxConcurrency=${maxConcurrency}, queueMode=reject`,
        },
        durationMs: now() - startedAt,
        ...(label !== undefined ? { label } : {}),
      }
      return result
    }

    try {
      // After acquiring the slot, re-check abort — the parent may have
      // cancelled while we were queued.
      if (managerCtrl.signal.aborted === true) {
        const r: LaneResult = {
          id: handle.id,
          ok: false,
          error: makeAbortError(`lane '${handle.id}': parent cascade aborted while queued`),
          durationMs: now() - startedAt,
          ...(label !== undefined ? { label } : {}),
        }
        return r
      }
      if (runner === undefined) {
        const r: LaneResult = {
          id: handle.id,
          ok: false,
          error: {
            kind: "spawn-failed",
            message: `lane '${handle.id}': no runner wired — pass DefaultLaneManagerOpts.runner`,
          },
          durationMs: now() - startedAt,
          ...(label !== undefined ? { label } : {}),
        }
        return r
      }

      // The per-lane controller (`laneCtrl`) was minted at spawn time and is
      // already chained off the manager controller (parent cascade) AND stored
      // in `laneCtrls` so `awaitAll` can abort it on timeout. We only need to
      // pass its signal through to the delegate here.

      // Merge the spec.delegate.signal with the lane controller — the
      // delegation runner already handles signal-aborted, so we only need
      // to pass the merged one through.
      const childSpec = handle.spec.delegate
      const mergedSignal =
        childSpec.signal !== undefined
          ? mergeSignals(childSpec.signal, laneCtrl.signal)
          : laneCtrl.signal

      const boomerang = await runner.delegate({
        ...childSpec,
        signal: mergedSignal,
      })

      // If the lane was aborted during the run, surface aborted regardless
      // of the boomerang shape (boomerang.errorKind may already be "cancelled"
      // — we project to the typed LaneError surface).
      if (
        laneCtrl.signal.aborted === true &&
        !boomerang.ok &&
        boomerang.errorKind === "cancelled"
      ) {
        const r: LaneResult = {
          id: handle.id,
          ok: false,
          error: makeAbortError(`lane '${handle.id}': cancelled mid-run`),
          durationMs: now() - startedAt,
          ...(label !== undefined ? { label } : {}),
        }
        return r
      }

      const r: LaneResult = {
        id: handle.id,
        ok: true,
        boomerang,
        durationMs: now() - startedAt,
        ...(label !== undefined ? { label } : {}),
      }
      return r
    } catch (err) {
      const msg = errMessage(err)
      const r: LaneResult = {
        id: handle.id,
        ok: false,
        error: {
          kind: "spawn-failed",
          message: `lane '${handle.id}': uncaught — ${msg}`,
          cause: err,
        },
        durationMs: now() - startedAt,
        ...(label !== undefined ? { label } : {}),
      }
      return r
    } finally {
      releaseSlot()
    }
  }

  return {
    spawnLane(spec: LaneSpec): LaneHandle {
      const id = mintId()
      // Pre-build handle so the promise factory can reference its own id.
      let resolvePromise!: (r: LaneResult) => void
      const promise = new Promise<LaneResult>((resolve) => {
        resolvePromise = resolve
      })
      const handle: LaneHandle = {
        id,
        spec,
        promise,
      }
      // Mint the per-lane controller HERE (spawn time) so both `runLane` and
      // `awaitAll` share it. Chain it off the manager controller so the parent
      // cascade still aborts it; `awaitAll`'s timeout arm aborts it directly to
      // force-cancel the delegate. `managerCtrl.signal.aborted` is read FRESH —
      // it mutates asynchronously when the parent signal fires.
      const laneCtrl = new AbortController()
      if (managerCtrl.signal.aborted) laneCtrl.abort()
      else managerCtrl.signal.addEventListener("abort", () => laneCtrl.abort(), { once: true })
      laneCtrls.set(handle, laneCtrl)
      // Kick the lane (fire-and-forget). The internal promise resolves with
      // a LaneResult (success or typed failure) — runLane NEVER throws.
      runLane(handle, laneCtrl, spec.label).then(
        (result) => resolvePromise(result),
        (err) => {
          // Defense-in-depth — runLane already wraps everything, but if a
          // future change introduces a throw, surface as spawn-failed.
          const msg = errMessage(err)
          const fallback: LaneResult = {
            id,
            ok: false,
            error: {
              kind: "spawn-failed",
              message: `lane '${id}': uncaught — ${msg}`,
              cause: err,
            },
            durationMs: 0,
            ...(spec.label !== undefined ? { label: spec.label } : {}),
          }
          resolvePromise(fallback)
        },
      )
      return handle
    },

    async awaitAll(
      handles: ReadonlyArray<LaneHandle>,
      timeoutMs?: number,
    ): Promise<ReadonlyArray<LaneResult>> {
      // Build a per-handle promise that resolves to either the lane's own
      // outcome OR a typed timeout. Ordered output via index mapping.
      const tasks = handles.map((h, idx) => {
        if (typeof timeoutMs === "number" && timeoutMs > 0) {
          return Promise.race<LaneResult>([
            h.promise,
            new Promise<LaneResult>((resolve) => {
              const timer = setTimeout(() => {
                // FORCE-CANCEL the lane's delegate before surfacing timeout —
                // otherwise the child agent keeps running (burning tokens/CPU)
                // past the deadline. This is the ADR-0285 CASCADE contract for
                // the timeout path (previously the delegate leaked).
                laneCtrls.get(h)?.abort()
                const r: LaneResult = {
                  id: h.id,
                  ok: false,
                  error: {
                    kind: "timeout",
                    message: `lane '${h.id}': exceeded awaitAll timeout (${timeoutMs}ms)`,
                  },
                  durationMs: timeoutMs,
                  ...(h.spec.label !== undefined ? { label: h.spec.label } : {}),
                }
                resolve(r)
              }, timeoutMs)
              // Unref so the timer never blocks process exit in tests.
              if (typeof (timer as { unref?: () => void }).unref === "function") {
                ;(timer as { unref?: () => void }).unref?.()
              }
            }),
          ]).then((r) => ({ r, idx }))
        }
        return h.promise.then((r) => ({ r, idx }))
      })
      const settled = await Promise.all(tasks)
      // Re-order back to input order (already preserved by `.idx` but we
      // build the output array explicitly so a future reorder doesn't
      // silently break the invariant).
      const out: LaneResult[] = new Array(handles.length)
      for (const { r, idx } of settled) out[idx] = r
      return Object.freeze(out)
    },
  }
}

/** Merge two AbortSignals into a third that fires when EITHER fires. Used to
 *  cascade the lane controller into the caller-supplied delegate signal. */
const mergeSignals = (a: AbortSignal, b: AbortSignal): AbortSignal => {
  const merged = new AbortController()
  if (a.aborted || b.aborted) {
    merged.abort()
    return merged.signal
  }
  const onA = (): void => merged.abort()
  const onB = (): void => merged.abort()
  a.addEventListener("abort", onA, { once: true })
  b.addEventListener("abort", onB, { once: true })
  return merged.signal
}
