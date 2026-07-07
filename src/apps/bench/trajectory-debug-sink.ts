/**
 * Trajectory DEBUG sidecar sink (platform layer).
 *
 * When the bench trajectory recorder runs in the `debug` tier
 * (`QUANTA_BENCH_RECORD_TRAJECTORY=debug`), subsystems ACROSS the run — the tool
 * executor, the edit tool, the phase-gate, the grader — can contribute keyed
 * debug slices that ride ALONGSIDE the recorded LLM turn as
 * `RecordedInteraction.metadata.debug`.
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
 */

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
  let buffer: Record<string, unknown> = {}
  const enrichers: DebugEnricher[] = []
  const enabled = () => isTrajectoryDebugEnabled()

  return {
    contribute(key, data) {
      if (!enabled()) return
      buffer[key] = data
    },
    append(key, item) {
      if (!enabled()) return
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
      const out: Record<string, unknown> = { ...buffer }
      buffer = {}
      for (const e of enrichers) {
        const v = e.sample()
        if (v !== undefined) out[e.key] = v
      }
      return Object.keys(out).length > 0 ? out : undefined
    },
    reset() {
      buffer = {}
      enrichers.length = 0
    },
  }
}

/** Process-scoped singleton. */
export const debugSink: DebugSink = createDebugSink()
