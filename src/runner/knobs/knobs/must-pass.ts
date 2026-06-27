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
 * envKey: `QUANTA_BENCH_MUST_PASS` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import type { AgentConfig } from "@/agent"
import { mustPassSchema } from "@/config/knob-schema/schemas/bench-gap-1"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import type { Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench", "agent-batch", "agent-interactive"]

interface MustPassValue {
  readonly mustPass: boolean
  readonly maxTrips?: number
  readonly stickyRed?: boolean
}

/** Non-NOOP apply — folds `cfg.verifyGuard`. Bound into the central registrar
 *  (`APPLY_BINDINGS`) AND used to derive the back-compat knob export; ONE
 *  definition so the derived knob is byte-identical to the registered one. */
export const applyMustPass = (
  cfg: AgentConfig,
  value: MustPassValue,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  // Preserve any `exactCommands` the bench driver already established on the
  // incoming verifyGuard (buildConfigGuards sets the per-instance verify
  // authority before knobs apply). Dropping it would silently broaden what
  // counts as a verify call — an unintended behavior change when the override
  // is set. exactOptionalPropertyTypes-friendly: only include fields when set.
  const exactCommands = cfg.verifyGuard?.exactCommands
  const verifyGuard = {
    mustPass: value.mustPass,
    ...(value.maxTrips !== undefined ? { maxTrips: value.maxTrips } : {}),
    ...(value.stickyRed === true ? { stickyRed: true } : {}),
    ...(exactCommands !== undefined ? { exactCommands } : {}),
  }
  return { ...cfg, verifyGuard }
}

// DERIVED from the schema SSOT (data) + the runner-side apply binding above.
// Registration is CENTRAL (`registerBenchKnobs`); no self-register here.
export const mustPassKnob = deriveKnob(mustPassSchema, applyMustPass)
