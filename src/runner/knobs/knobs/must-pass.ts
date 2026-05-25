/**
 * Knob: `must-pass` — verify-guard outcome-gate (RCA 2026-05-25 sanity).
 *
 * NEW knob — exposes the previously-hardcoded `verifyGuard` block in
 * `src/runner/batch/eval/driver.ts` `buildConfig` (currently auto-on for
 * `instance.swebench` with `{ mustPass: true, maxTrips: 2 }`). With the knob,
 * a caller can override or disable the gate explicitly. The bench driver's
 * swebench auto-on remains its own concern (the knob's `default` is
 * `undefined` — the driver applies its hardcoded posture when no knob value
 * is set).
 *
 * Domain:
 *   - `"off"`           ⇒ `{ mustPass: false }`         (force guard off)
 *   - `"1"` / `"on"`    ⇒ `{ mustPass: true, maxTrips: 2 }`   (legacy)
 *   - `"strict"`        ⇒ `{ mustPass: true, maxTrips: 2 }`   (alias)
 *   - `"2"`             ⇒ `{ mustPass: true, maxTrips: 2 }`
 *   - `"3"`             ⇒ `{ mustPass: true, maxTrips: 3 }`
 *   - anything else (absent / `"true"` / `"yes"` / `"4"` / garbage) ⇒
 *     `undefined` (knob does nothing; driver's existing posture stands)
 *
 * The strict allow-list (no integer parsing beyond `2`/`3`) is deliberate —
 * `maxTrips` semantics are sensitive (each trip is one full reminder cycle);
 * we surface only the operational values observed in the codebase. No
 * heuristics.
 */

import type { AgentConfig } from "@/agent"
import {type Knob, type Surface } from "../types"
import { registerKnob } from "../registry"

const SURFACES: readonly Surface[] = ["bench", "agent-batch", "agent-interactive"]

interface MustPassValue {
  readonly mustPass: boolean
  readonly maxTrips?: number
}

const parseMustPass = (raw: string | undefined): MustPassValue | undefined => {
  if (raw === undefined) return undefined
  if (raw === "off") return { mustPass: false }
  if (raw === "1" || raw === "on" || raw === "strict") return { mustPass: true, maxTrips: 2 }
  if (raw === "2") return { mustPass: true, maxTrips: 2 }
  if (raw === "3") return { mustPass: true, maxTrips: 3 }
  return undefined
}

const applyMustPass = (
  cfg: AgentConfig,
  value: MustPassValue,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  // exactOptionalPropertyTypes-friendly: only include `maxTrips` when defined.
  const verifyGuard =
    value.maxTrips !== undefined
      ? { mustPass: value.mustPass, maxTrips: value.maxTrips }
      : { mustPass: value.mustPass }
  return { ...cfg, verifyGuard }
}

export const mustPassKnob: Knob<MustPassValue> = {
  id: "must-pass",
  envKey: "QUANTA_BENCH_MUST_PASS",
  category: "verify",
  surfaces: SURFACES,
  parse: parseMustPass,
  apply: applyMustPass,
  describe: "verify-guard outcome-gate (must pass, not just presence)",
  default: undefined,
  source: "RCA 2026-05-25 sanity",
}

registerKnob(mustPassKnob)
