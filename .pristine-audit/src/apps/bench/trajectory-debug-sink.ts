/**
 * Trajectory DEBUG sidecar sink (platform layer).
 *
 * When the bench trajectory recorder runs in the `debug` tier
 * (`QUANTA_BENCH_RECORD_TRAJECTORY=debug`), subsystems ACROSS the run can
 * contribute keyed debug slices that ride ALONGSIDE the recorded LLM turn as
 * `RecordedInteraction.metadata.debug`.
 *
 * WIRED CONTRIBUTORS (reality, 2026-07 — ALL THREE LIVE, none pending):
 * - `"toolExec"` (driver.ts) — per-tool-result timing / outcome / edit target.
 * - `"verdict"` (contributeVerdictDebug) — the grade/verify outcome (pass/fail
 *   bit, patch size, any observation verdict / harness error decided there).
 * - `"editTrace"` (contributeEditTraceDebug) — the per-edit trace: tool (always
 *   `"edit"`), target file, mode (exact/fuzzy/fast-apply), match outcome
 *   (matched/stale/failed), occurrence count, and any fuzzy-escalation flag, ALL
 *   derived from the edit tool's OWN output message (no recompute/re-read).
 *   APPEND-style, so multiple edits in a turn accumulate as a list. SCOPE = the
 *   `edit` tool ONLY: the tap fires for every `write_filesystem` tool, but the
 *   grammar is edit-specific, so `write` / `scripted_replace` / `apply_patch` /
 *   office+image writers are dropped rather than mis-moded (jul-13 honesty fix).
 * Enricher priority (jul-08 platform note): verdict > editTrace > toolExec. The
 * debug-sink contributor set is now COMPLETE — no enricher remains TODO.
 *
 * DESIGN CONTRACT
 * - REPLAY-NEUTRAL: everything here lands in `metadata` only. The cassette match
 *   key is `request`-hash, so debug enrichment can NEVER invalidate a cross-box
 *   replay hit. (Same guarantee as the existing instanceId/runId metadata.)
 * - DEFAULT-OFF, ZERO-OVERHEAD: when the gate is unset, {@link contribute} is a
 *   no-op and no buffer is allocated — the recording path stays byte-identical.
 * - EXTENSIBLE BY KEY: a new debug feature calls `contribute("<newKey>", data)`.
 *   No change to the recorder, the store, or this module's core is required —
 *   the key namespace IS the plugin surface.
 *
 * The sink is a process-scoped singleton because the contributing subsystems
 * (tool runtime, grader) do NOT share a call-stack with the LLM port that owns
 * the recording; a keyed buffer drained at turn-commit is the loose coupling.
 *
 * PARALLEL-SAFE (per-lane buffers): the bench runs candidates CONCURRENTLY
 * (repair-breadth / verify-select), each with a live per-tool contributor
 * (`toolExec`). Their slices must NOT race into one buffer. The buffer is keyed
 * by the ambient {@link currentLane} (set by the fork sites via
 * `laneContext.run(lane, …)`): `contribute`/`append` write into the CURRENT
 * lane's bucket, and the recorder's per-turn `drain` — running under the SAME
 * lane context — reads and clears only that lane's bucket. Serial runs (no lane
 * context) share one default bucket, byte-identical to the pre-parallel path.
 */

import { currentLane } from "@/shared"

/** Falsy tokens that mean "off" for the debug gate (mirrors {@link isFalsyToken}). */
const isOffToken = (v: string | undefined): boolean =>
  v === undefined ||
  v === "" ||
  v === "0" ||
  v.toLowerCase() === "off" ||
  v.toLowerCase() === "false"

/**
 * Debug tier is ON iff `QUANTA_BENCH_RECORD_TRAJECTORY` is exactly `debug`
 * (case-insensitive), OR the explicit `QUANTA_BENCH_TRAJECTORY_DEBUG` escape
 * hatch is a truthy token. Keeping the tier on the SAME var as recording means a
 * `debug` value both records AND enriches — one knob, no drift.
 */
export const isTrajectoryDebugEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => {
  const rec = env.QUANTA_BENCH_RECORD_TRAJECTORY
  if (rec !== undefined && rec.toLowerCase() === "debug") return true
  return !isOffToken(env.QUANTA_BENCH_TRAJECTORY_DEBUG)
}

/**
 * A registered contributor of debug slices. Enrichers are OPTIONAL — most
 * subsystems just push via {@link contribute}. A registered enricher is for the
 * PULL case: something that should be sampled lazily at drain time (e.g. a
 * running counter) rather than pushed per-event.
 */
export interface DebugEnricher {
  readonly key: string
  /** Sampled at drain; return `undefined` to contribute nothing this turn. */
  readonly sample: () => unknown
}

interface DebugSink {
  /** Push a keyed slice for the CURRENT turn (last-write-wins). No-op off-gate. */
  contribute(key: string, data: unknown): void
  /**
   * Accumulate `item` under `key` as an array for the CURRENT turn — the
   * ergonomic path for keys with MANY events per turn (e.g. every `toolExec`
   * call), where {@link contribute}'s last-write-wins would drop all but the
   * last. No-op when the gate is off. Throws if `key` already holds a non-array
   * (caller mixed the two modes on one key).
   */
  append(key: string, item: unknown): void
  /** Register a pull-style enricher sampled at every drain. */
  register(enricher: DebugEnricher): void
  /**
   * Return the accumulated slices (pushed + sampled) and CLEAR the pushed
   * buffer, readying the next turn. Returns `undefined` when nothing accrued so
   * the caller can omit the `debug` key entirely (keeps records lean).
   */
  drain(): Record<string, unknown> | undefined
  /** Test seam: wipe all state (buffer + enrichers). */
  reset(): void
}

const createDebugSink = (): DebugSink => {
  // Per-lane buffers so concurrent candidates never cross-contaminate. Keyed by
  // the ambient lane (currentLane()); serial runs use the "" default bucket.
  const buffers = new Map<string, Record<string, unknown>>()
  const enrichers: DebugEnricher[] = []
  const enabled = () => isTrajectoryDebugEnabled()
  const laneKey = (): string => currentLane() ?? ""
  const bucketFor = (k: string): Record<string, unknown> => {
    let b = buffers.get(k)
    if (b === undefined) {
      b = {}
      buffers.set(k, b)
    }
    return b
  }

  return {
    contribute(key, data) {
      if (!enabled()) return
      bucketFor(laneKey())[key] = data
    },
    append(key, item) {
      if (!enabled()) return
      const buffer = bucketFor(laneKey())
      const cur = buffer[key]
      if (cur === undefined) {
        buffer[key] = [item]
        return
      }
      if (!Array.isArray(cur)) {
        throw new Error(
          `debugSink.append: key ${JSON.stringify(key)} already holds a non-array (set via contribute) — do not mix contribute + append on one key`,
        )
      }
      cur.push(item)
    },
    register(enricher) {
      if (enrichers.some((e) => e.key === enricher.key)) return
      enrichers.push(enricher)
    },
    drain() {
      if (!enabled()) return undefined
      // Read + clear ONLY the current lane's bucket — the recorder's per-turn
      // drain runs under the same lane context as that lane's contributions.
      const k = laneKey()
      const out: Record<string, unknown> = { ...(buffers.get(k) ?? {}) }
      buffers.delete(k)
      for (const e of enrichers) {
        const v = e.sample()
        if (v !== undefined) out[e.key] = v
      }
      return Object.keys(out).length > 0 ? out : undefined
    },
    reset() {
      buffers.clear()
      enrichers.length = 0
    },
  }
}

/** Process-scoped singleton. */
export const debugSink: DebugSink = createDebugSink()
