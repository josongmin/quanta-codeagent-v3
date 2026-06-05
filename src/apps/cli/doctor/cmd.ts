/**
 * `/doctor` slash command (RFC jun-6-doctor-selfcheck §4.4, §5).
 *
 * Read-only startup self-diagnostic: runs the pure {@link runDoctor} registry
 * over INJECTED {@link DoctorProbes}, renders the rounded-box (or `--json`)
 * report, and returns a non-zero exit code iff any check `fail`ed.
 *
 * Probes are injected (`deps.probes`) so the command body is testable with
 * fake probes — no real auth / network / fs in the unit tests. The surface
 * default (`defaultDoctorProbes`) wires the real subsystem accessors.
 */

import type { SlashCommand, SlashContext } from "../slash-contract"
import { doctorExitCode, runDoctor } from "./registry"
import { renderDoctorJson, renderDoctorReport } from "./render"
import type { DoctorProbes } from "./types"

export interface DoctorDeps {
  /** Build the probe set for a `/doctor` run. Injected so the surface wires
   *  real accessors and tests inject fakes (closed-port DI). */
  readonly probes: (ctx: SlashContext) => DoctorProbes
}

const hasFlag = (args: readonly string[], flag: string): boolean => args.includes(flag)

export const buildDoctorCmd = (deps: DoctorDeps): SlashCommand => ({
  name: "/doctor",
  describe: "Run a read-only health self-check (auth/terminal/MCP/config/state-DB)",
  category: "other",
  async run(args, ctx: SlashContext) {
    const results = await runDoctor(deps.probes(ctx))
    const json = hasFlag(args, "--json")
    ctx.out(json ? `${renderDoctorJson(results)}\n` : `${renderDoctorReport(results)}\n`)
    return doctorExitCode(results)
  },
})
