/**
 * Knob: `lsp-steer` — append the LSP-nav GROUNDING nudge to the localize-phase
 * Phase-1 block message.
 *
 * DEFAULT-ON whenever LSP nav is on (coupled to `lsp` in `benchPostureFromState`).
 * When on (and `localize-phase` is active), the Phase-1 edit-block reminder
 * steers the model to `lsp_definition` (resolve the TRUE owner — text matches
 * land on the wrong class/override) and `lsp_references` (surface every
 * multi-file co-change site) before editing. Targets the two failure modes from
 * the hard-tier causal audit; measured gap = ~0% nav-tool usage despite the
 * tools being wired + live, so the steer ships ON, not hidden behind a preset.
 *
 * A NUDGE, never a hard gate (pyright over-reports on Django dynamics). Read by
 * `benchPostureFromState` → `localizePhase.lspGroundingSteer`; `apply` is a
 * no-op (the value is consumed via the posture path, like `localize-phase`).
 *
 * Tri-state OFF-switch (for an A/B baseline): `QUANTA_BENCH_LSP_STEER=off|0|false`
 * ⇒ explicit FALSE (steer suppressed even with nav on). Unset ⇒ undefined ⇒
 * posture defaults it ON when nav is on. Pointless without `lsp:1`.
 */

import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

export const lspSteerKnob: Knob<boolean> = {
  id: "lsp-steer",
  envKey: "QUANTA_BENCH_LSP_STEER",
  category: "tool",
  surfaces: SURFACES,
  // Tri-state: true (on) | false (explicit off-switch) | undefined (unset ⇒
  // posture defaults ON when nav is on). Closed parser, no coercion.
  parse: (raw) =>
    raw === "1" || raw === "on" || raw === "true"
      ? true
      : raw === "0" || raw === "off" || raw === "false"
        ? false
        : undefined,
  // No-op apply: the value is consumed via benchPostureFromState (posture path),
  // exactly like `localize-phase`. Keeping apply identity preserves byte-stable
  // configs for every non-bench surface.
  apply: (cfg) => cfg,
  describe: "append LSP-nav grounding nudge to the localize-phase block message",
  source: "jun-17 measured LSP-nav usage gap",
  costMultiplier: 1,
}

registerKnob(lspSteerKnob)
