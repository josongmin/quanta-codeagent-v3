/**
 * `/doctor` self-check slice barrel (RFC jun-6-doctor-selfcheck).
 *
 * Pure leaf:   types / registry / render (no ambient access).
 * Surface:     cmd (the `/doctor` SlashCommand) + default-probes (real wiring).
 *
 * `doctorCmd` is the ready-to-register command, built with the real
 * `defaultDoctorProbes`. Register it in the app slash registry exactly like
 * `permissionCmd` / `mcpCmd` (see the registration line in the report).
 */

import { buildDoctorCmd } from "./cmd"
import { defaultDoctorProbes } from "./default-probes"

export { buildDoctorCmd, type DoctorDeps } from "./cmd"
export { defaultDoctorProbes } from "./default-probes"
export { DOCTOR_CHECKS, doctorExitCode, runDoctor } from "./registry"
export { renderDoctorJson, renderDoctorReport } from "./render"
export type {
  AuthProbeResult,
  Check,
  CheckResult,
  CheckStatus,
  ConfigProbeResult,
  DoctorProbes,
  McpServerProbe,
  StateDbProbeResult,
  StoreHealthProbeResult,
  TerminalProbeResult,
} from "./types"
export { MIN_TERMINAL_COLUMNS } from "./types"

/** Ready-to-register `/doctor` command wired to the real subsystem probes. */
export const doctorCmd = buildDoctorCmd({ probes: defaultDoctorProbes })
