/**
 * Reference knob — `lsp`.
 *
 * Enables the 8 LSP-nav tools (ADR-0015) by appending `lspNavToolList()` to
 * the active tool registry. This knob also accepts explicit false
 * (`0` / `off` / `false`) so an env-layer override can suppress a preset's
 * `lsp:1` on bench runs.
 *
 * Surfaces: bench, agent-batch, agent-interactive. CLI/IDE entries do not
 * register LSP tools by this knob (those surfaces wire LSP through their
 * own assembly path).
 * envKey: `QUANTA_BENCH_LSP` (the SSOT declaration lives on the schema; this
 * runner-side knob derives from it).
 */

import type { AgentConfig } from "@/agent"
import { lspNavToolList } from "@/agent"
import { lspSchema } from "@/config/knob-schema/schemas/bench-gap-1"
import { deriveKnob } from "@/runner/knobs/derive"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"

/** Reconstruct the underlying `Tool[]` from a registry — `ToolRegistry`
 *  is construct-only and exposes specs by name; we round-trip them here. */
const registryTools = (r: ToolRegistry): Tool[] =>
  r
    .specs()
    .map((s) => r.get(s.name))
    .filter((t): t is Tool => t !== undefined)

/** Non-NOOP apply — appends the 8 LSP-nav tools to the registry. Bound into the
 *  central registrar (`APPLY_BINDINGS`) AND used to derive the back-compat knob
 *  export; ONE definition so the derived knob is byte-identical to registered. */
export const applyLsp = (cfg: AgentConfig, on: boolean): AgentConfig => {
  if (!on) return cfg
  const merged = new ToolRegistry([
    ...registryTools(cfg.registry),
    ...lspNavToolList(() => cfg.cwd),
  ])
  return { ...cfg, registry: merged }
}

// DERIVED from the schema SSOT (data) + the runner-side apply binding above.
// Registration is CENTRAL (`registerBenchKnobs`); no self-register here.
export const lspKnob = deriveKnob(lspSchema, applyLsp)
