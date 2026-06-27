/**
 * Pillar A — authored {@link KnobSchema} declarations for the repro/validate
 * family of bench knobs. These are the SSOT: the registry `Knob`, the inventory
 * entry, the posture field, and the default-OFF proof all DERIVE from here
 * (see ../derive).
 *
 * Source-of-truth fidelity: each schema's fields are authored to match the
 * EXISTING hand-maintained data so the derive can be proven equal —
 *   - `parse`    mirrors src/runner/knobs/knobs/<id>.ts verbatim,
 *   - `describe`/`default`/`kind`/`readSite`/`envKey` mirror the CURRENT
 *     src/config/knob-inventory/bench.ts entry (the inventory describe, which
 *     differs from the registry knob's terse `--help` describe; the SSOT carries
 *     the inventory text).
 * The parity test (tests/unit/kernel/derive-parity.test.ts) locks this equality.
 *
 * Additive: not registered, not imported by the live driver.
 */

import type { KnobSchema } from "../contracts"

const BENCH: readonly ["bench"] = ["bench"] as const

/* ── repro-test (QUANTA_BENCH_REPRO_TEST) ─────────────────────────────────── */
interface ReproTestValue {
  readonly samples: number
}
const parseReproTest = (raw: string | undefined): ReproTestValue | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 40) return undefined
  return { samples: n }
}
export const reproTestSchema: KnobSchema<ReproTestValue> = {
  id: "repro-test",
  envKey: "QUANTA_BENCH_REPRO_TEST",
  kind: "int",
  domain: { range: [1, 40] },
  default: undefined,
  describe: "Bench: repro-test selection K.",
  knobDescribe: "Agentless §3.3.1 reproduction-test K-sample generation",
  readSite: "runner/batch/eval/driver.ts",
  surfaces: BENCH,
  parse: parseReproTest,
  costMultiplier: 40,
  unit: "samples",
  source: "Agentless paper §3.3.1",
}

/* ── repro-vote (QUANTA_BENCH_REPRO_VOTE) ─────────────────────────────────── */
const parseReproVote = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "" || s === "0" || s === "off" || s === "false") return undefined
  return true
}
export const reproVoteSchema: KnobSchema<boolean> = {
  id: "repro-vote",
  envKey: "QUANTA_BENCH_REPRO_VOTE",
  kind: "bool",
  default: false,
  describe:
    "Bench: K-of-N resolved gate — re-run reproducing repro set on patched tree and majority-vote 'Issue resolved'. Requires repro-test. Default-OFF ⇒ byte-identical.",
  knobDescribe:
    "K-of-N resolved gate: re-run the reproducing repro set on the patched tree and majority-vote 'Issue resolved' (removes the false-NEGATIVE single-script oracle)",
  readSite: "runner/knobs/knobs/repro-vote.ts",
  surfaces: BENCH,
  parse: parseReproVote,
  source: "jun-19 repro oracle quality (Agentless §3.3.1 resolved-side majority vote)",
}

/* ── repro-doubt (QUANTA_BENCH_REPRO_DOUBT) ───────────────────────────────── */
interface ReproDoubtValue {
  readonly stuckRuns: number
}
const parseReproDoubt = (raw: string | undefined): ReproDoubtValue | undefined => {
  if (typeof raw !== "string") return undefined
  if (raw.length === 0) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  if (!Number.isInteger(n)) return undefined
  if (n < 2) return undefined
  if (n > 12) return undefined
  return { stuckRuns: n }
}
export const reproDoubtSchema: KnobSchema<ReproDoubtValue> = {
  id: "repro-doubt",
  envKey: "QUANTA_BENCH_REPRO_DOUBT",
  kind: "int",
  category: "agent",
  domain: { range: [2, 12] },
  default: undefined,
  describe:
    "Bench: after N consecutive test re-runs with no edit, steer agent to doubt its repro test (break verify_loop_stuck). Domain N in [2,12]. Default-OFF.",
  knobDescribe:
    "After N test re-runs with no edit, steer the agent to doubt its repro test (break verify_loop_stuck)",
  readSite: "runner/knobs/knobs/repro-doubt.ts",
  surfaces: BENCH,
  parse: parseReproDoubt,
  unit: "runs",
  source: "jun-20-bestofn-wrong-repro-oracle-root",
}

/* ── repro-exec-timeout (QUANTA_BENCH_REPRO_EXEC_TIMEOUT_MS) ───────────────── */
const MIN_EXEC_TIMEOUT_MS = 5_000
const MAX_EXEC_TIMEOUT_MS = 600_000
const parseReproExecTimeout = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "" || !/^\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < MIN_EXEC_TIMEOUT_MS || n > MAX_EXEC_TIMEOUT_MS) return undefined
  return n
}
export const reproExecTimeoutSchema: KnobSchema<number> = {
  id: "repro-exec-timeout",
  envKey: "QUANTA_BENCH_REPRO_EXEC_TIMEOUT_MS",
  kind: "int",
  domain: { range: [MIN_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS] },
  default: undefined,
  describe:
    "Bench: per-repro-script exec timeout (ms). Domain [5000,600000]. Unset ⇒ 60000 (byte-identical). Raise for slow repos; it is the PER-SCRIPT cap, not the per-instance budget.",
  knobDescribe:
    "Bench: per-repro-script exec timeout (ms, default 60000). Raise for slow repos whose repro scripts exceed 60s; it is the PER-SCRIPT cap, not the per-instance budget.",
  readSite: "runner/knobs/knobs/repro-exec-timeout.ts",
  surfaces: BENCH,
  parse: parseReproExecTimeout,
  costMultiplier: 1,
  unit: "ms",
  source: "jun-22 magic-number config-extraction (was hardcoded DEFAULT_EXEC_TIMEOUT_MS=60000)",
}
