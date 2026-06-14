/**
 * Knob: `retry-transient` — per-instance retry cap for transient failures
 * (empty patch / infra-fail). Real-fails are FROZEN no-retry by policy.
 *
 * Default-OFF (N unset ⇒ single attempt). Migrated from `parseRetryTransientEnv`
 * (envKey `QUANTA_BENCH_RETRY_TRANSIENT`). Domain: integer N in [1, 5]; anything
 * else ⇒ `undefined`.
 *
 * APPLY IS A NOOP — the cap is consumed out of band by the bench driver's
 * retry wrapper (`runInstance` → `runRetryLoop`), not stored on `AgentConfig`.
 * Registry status is required so the resolver / report / preset layer see it.
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

const parseRetryTransient = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 5) return undefined
  return n
}

const applyRetryTransient = (cfg: AgentConfig): AgentConfig => cfg

export const retryTransientKnob: Knob<number> = {
  id: "retry-transient",
  envKey: "QUANTA_BENCH_RETRY_TRANSIENT",
  category: "validation",
  surfaces: SURFACES,
  parse: parseRetryTransient,
  apply: applyRetryTransient,
  describe: "Retry cap for transient failures (empty-patch / infra-fail; real-fail never retried)",
  source: "measurement-stability wrapper",
}

registerKnob(retryTransientKnob)
