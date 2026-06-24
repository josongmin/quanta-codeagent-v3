/**
 * Reference knob — `lsp`.
 *
 * Enables the 8 LSP-nav tools (ADR-0015) by appending `lspNavToolList()` to
 * the active tool registry. Off (parse returns `undefined`) keeps the
 * config byte-identical to the pre-knob path.
 *
 * Surfaces: bench, agent-batch, agent-interactive. CLI/IDE entries do not
 * register LSP tools by this knob (those surfaces wire LSP through their
 * own assembly path).
 */

import { lspNavToolList } from "@/agent"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"
import { registerKnob } from "../registry"
import type { Knob } from "../types"

/** Reconstruct the underlying `Tool[]` from a registry — `ToolRegistry`
 *  is construct-only and exposes specs by name; we round-trip them here. */
const registryTools = (r: ToolRegistry): Tool[] =>
  r
    .specs()
    .map((s) => r.get(s.name))
    .filter((t): t is Tool => t !== undefined)

export const lspKnob: Knob<boolean> = {
  id: "lsp",
  envKey: "QUANTA_BENCH_LSP",
  category: "tool",
  surfaces: ["bench", "agent-batch", "agent-interactive"],
  parse: (raw) => (raw === "1" || raw === "on" || raw === "true" ? true : undefined),
  apply: (cfg, on) => {
    if (!on) return cfg
    const merged = new ToolRegistry([...registryTools(cfg.registry), ...lspNavToolList(() => cfg.cwd)])
    return { ...cfg, registry: merged }
  },
  describe: "LSP nav tools (8 tools — ADR-0015)",
  source: "ADR-0015",
  costMultiplier: 1,
}

registerKnob(lspKnob)
