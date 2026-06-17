/**
 * T-301 — VerificationPlan builder. PURE + deterministic. Picks the primary rail
 * from PUBLIC evidence only and enforces red-on-injection for synthesized repros:
 * a repro becomes the primaryRail/required ONLY after it proved RED on the
 * unpatched base — otherwise it is demoted to optional (never a false-green gate).
 */
import type { VerificationPlan, VerificationPlanInput, VerificationStep } from "./types"

const DEFAULT_MAX_REQUIRED = 3

export type { VerificationPlan, VerificationPlanInput } from "./types"

export const buildVerificationPlan = (input: VerificationPlanInput): VerificationPlan => {
  const maxRequired = input.maxRequired ?? DEFAULT_MAX_REQUIRED
  const baseValidatedRed = input.reproScript?.baseValidatedRed ?? false

  const ownerSteps: VerificationStep[] = (input.ownerNearTests ?? []).map((cmd) => ({
    kind: "owner-test",
    cmd,
  }))
  const smokeSteps: VerificationStep[] = (input.touchedModuleSmoke ?? []).map((cmd) => ({
    kind: "module-smoke",
    cmd,
  }))
  const reproStep: VerificationStep | undefined = input.reproScript
    ? { kind: "repro", cmd: input.reproScript.cmd }
    : undefined

  // primaryRail authority order: a RED-validated repro > owner-near test > smoke.
  const primaryRail: VerificationStep | null =
    reproStep && baseValidatedRed ? reproStep : (ownerSteps[0] ?? smokeSteps[0] ?? null)

  const required: VerificationStep[] = []
  const optional: VerificationStep[] = []
  if (primaryRail) required.push(primaryRail)

  // remaining owner tests fill required up to the cap; the rest are optional.
  for (const s of ownerSteps) {
    if (s === primaryRail) continue
    if (required.length < maxRequired) required.push(s)
    else optional.push(s)
  }
  for (const s of smokeSteps) {
    if (s === primaryRail) continue
    optional.push(s)
  }
  // a repro that did NOT validate red is demoted to optional — never required.
  if (reproStep && reproStep !== primaryRail) optional.push(reproStep)

  return { primaryRail, required, optional, baseValidatedRed }
}
