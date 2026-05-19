import { toError } from "@/shared"
import type { StreamPort } from "../ports"
import type { AgentEvent } from "../types"

/** A degraded-component record surfaced for the recorder/caller to turn into
 *  an `observability_degraded` trajectory event. TeeStream itself never writes
 *  trajectory — it only fans out and tracks. */
export interface DegradedRecord {
  component: string
  reason: string
  count: number
}

export interface TeeStreamOpts {
  /** eval/strict mode: a failing port rethrows so the caller can mark the
   *  instance verdict `degraded`. Default `false` (product/session). */
  strict?: boolean
}

/**
 * Pure fan-out `StreamPort`. Forwards every event to every wrapped port in
 * order. In non-strict mode one faulty port can never starve the others: its
 * error is swallowed and remembered (per-port count keyed by reason) so the
 * caller can emit an `observability_degraded` trajectory event. In strict
 * mode the first failure rethrows. No IO, deterministic.
 */
export class TeeStream implements StreamPort {
  private readonly strict: boolean
  private readonly failures = new Map<string, DegradedRecord>()

  constructor(
    private readonly ports: readonly StreamPort[],
    opts: TeeStreamOpts = {},
  ) {
    this.strict = opts.strict ?? false
  }

  emit(event: AgentEvent): void {
    for (let i = 0; i < this.ports.length; i++) {
      this.forward(this.ports[i], i, event)
    }
  }

  private forward(port: StreamPort | undefined, index: number, event: AgentEvent): void {
    if (port === undefined) return
    try {
      port.emit(event)
    } catch (e) {
      if (this.strict) throw e
      this.track(index, toError(e).message)
    }
  }

  private track(index: number, reason: string): void {
    const key = `${index}:${reason}`
    const existing = this.failures.get(key)
    if (existing) {
      existing.count += 1
      return
    }
    this.failures.set(key, { component: "TeeStream", reason, count: 1 })
  }

  /** Snapshot of degraded ports (one record per port+reason). */
  degraded(): DegradedRecord[] {
    return [...this.failures.values()].map((r) => ({ ...r }))
  }
}
