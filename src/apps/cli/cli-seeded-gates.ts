/**
 * CLI seed union — one data owner for the exact env knobs the CLI defaults ON.
 *
 * The entrypoint seeds these names, while `/help` renders their rollback rows.
 * Keeping both projections here prevents a CLI-default tool gate from becoming
 * active but undiscoverable (the operator escape hatch is always `=0`).
 */

import { GATED_TOOLS, seedEnvVarsForSurface } from "@/tool/surface/manifest"
import { CLI_FEATURE_GATES } from "./cli-feature-gates"

export interface CliSeededGate {
  readonly gate: string
  readonly describe: string
}

const toolGateDescription = (gate: string): string => {
  const entry = GATED_TOOLS.find((candidate) => {
    const configured = candidate.gate
    const env =
      configured.kind === "env-flag"
        ? configured.env
        : configured.kind === "config-slot"
          ? configured.env
          : undefined
    return env === gate
  })
  return entry === undefined
    ? "CLI-default tool availability (set '0' to disable)"
    : `${entry.name} tool availability (set '0' to disable)`
}

const toolSeededGates = (): readonly CliSeededGate[] =>
  seedEnvVarsForSurface("cli").map((gate) => ({ gate, describe: toolGateDescription(gate) }))

/** Canonical deduplicated seed order used by both CLI startup and `/help`. */
export const CLI_SEEDED_GATES: readonly CliSeededGate[] = (() => {
  const seen = new Set<string>()
  return [...CLI_FEATURE_GATES, ...toolSeededGates()].filter(({ gate }) => {
    if (seen.has(gate)) return false
    seen.add(gate)
    return true
  })
})()

export const CLI_SEEDED_GATE_NAMES: readonly string[] = CLI_SEEDED_GATES.map(({ gate }) => gate)
