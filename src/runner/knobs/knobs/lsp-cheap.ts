/**
 * Knob: `lsp-cheap` — register the CHEAP / index-backed LSP-nav tier on the
 * bench surface (REPORT-jun26-tool-impl-vs-frontier §2/§4.5).
 *
 * DEFAULT-ON gated-flip. Surfaces the above-frontier semantic-nav moat
 * (definition / hover / type_definition / document_symbol / workspace_symbol /
 * incoming·outgoing_calls / code_action / format / signature_help) to the bench
 * model WITHOUT the two members MEASURED intractable on large repos —
 * `lsp_references` / `lsp_implementation` (jun-19: pyright `textDocument/
 * references` timed out on sympy at 15s AND 60s). Those stay opt-in behind the
 * full `lsp` knob (`QUANTA_BENCH_LSP` / `QUANTA_LSP_TOOLS=full`), which supersets
 * this tier and additionally exposes the expensive members.
 *
 * Tri-state OFF-switch (the A/B / byte-identity baseline):
 * `QUANTA_BENCH_LSP_CHEAP=off|0|false` ⇒ explicit FALSE ⇒ NO cheap nav tools ⇒
 * the bench nav surface is byte-identical to the legacy default-OFF posture.
 * Unset ⇒ undefined ⇒ `benchPostureFromState` defaults it ON.
 *
 * Read by `benchPostureFromState` → `BenchPosture.lspNavCheap`; `apply` is a
 * no-op (the value is consumed via the posture path, exactly like `lsp-steer` /
 * `localize-phase`). Ignored when the full `lsp` knob is on (the driver only
 * registers ONE nav list).
 */

import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

export const lspCheapKnob: Knob<boolean> = {
  id: "lsp-cheap",
  envKey: "QUANTA_BENCH_LSP_CHEAP",
  category: "tool",
  surfaces: SURFACES,
  // Tri-state: true (on) | false (explicit off-switch / byte-identity baseline)
  // | undefined (unset ⇒ posture defaults ON). Closed parser, no coercion.
  parse: (raw) =>
    raw === "1" || raw === "on" || raw === "true"
      ? true
      : raw === "0" || raw === "off" || raw === "false"
        ? false
        : undefined,
  // No-op apply: consumed via benchPostureFromState (posture path), like
  // `lsp-steer`. Identity apply keeps every non-bench surface byte-stable.
  apply: (cfg) => cfg,
  describe: "register the cheap/index-backed LSP-nav tier (no references/implementation)",
  source: "REPORT-jun26-tool-impl-vs-frontier §4.5",
  costMultiplier: 1,
}

registerKnob(lspCheapKnob)
