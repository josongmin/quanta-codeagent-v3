/**
 * T-301 — VerificationPlan builder. PURE + deterministic. Picks the primary rail
 * from PUBLIC evidence only and enforces red-on-injection for synthesized repros:
 * a repro becomes the primaryRail/required ONLY after it proved RED on the
 * unpatched base — otherwise it is demoted to optional (never a false-green gate).
 */
import type {
  SuccessPredicate,
  VerificationAuthority,
  VerificationPlan,
  VerificationPlanInput,
  VerificationStep,
} from "./types"

const DEFAULT_MAX_REQUIRED = 3

export type { VerificationPlan, VerificationPlanInput } from "./types"

/**
 * Default (execution-authority) success contract for a step that carries no
 * issue-declared exact output. P1 (jun-23) made synthesized repros real pytest
 * tests, so the contract is now the PROCESS verdict: green pytest / exit 0 means
 * fixed; a failing assertion means still reproduced. Owner tests and module
 * smoke already use the same exit-zero contract.
 */
const defaultSuccessPredicate = (_kind: VerificationStep["kind"]): SuccessPredicate => ({
  type: "test_exit_zero",
})

/**
 * Encode a PUBLIC issue-declared expected output as a typed exact-output
 * contract. This is the gap-B spec-fidelity rail — public input, never oracle.
 */
const issueExpectedPredicate = (
  expected: NonNullable<VerificationPlanInput["issueDeclaredExpected"]>,
): { predicate: SuccessPredicate; authority: VerificationAuthority } => {
  switch (expected.kind) {
    case "symbolic":
      return {
        predicate: { type: "symbolic_repr_equals", expectedRepr: expected.value },
        authority: "structure",
      }
    case "stdout":
      return {
        predicate: { type: "stdout_contains", substring: expected.value },
        authority: "execution",
      }
    case "stdout-empty":
      // The issue declares the correct behavior is to emit NOTHING. `value` is a
      // human description (the empty-ness is the contract), so it is NOT used as a
      // substring — the predicate is the exact-empty stdout shape.
      return {
        predicate: { type: "stdout_exact_empty" },
        authority: "execution",
      }
    default:
      // "latex" or unspecified ⇒ exact string equality.
      return {
        predicate: { type: "latex_or_string_exact", expected: expected.value },
        authority: "exact-diff",
      }
  }
}

const ownerStepsOf = (input: VerificationPlanInput): VerificationStep[] =>
  (input.ownerNearTests ?? []).map((cmd) => ({
    kind: "owner-test",
    cmd,
  }))

const smokeStepsOf = (input: VerificationPlanInput): VerificationStep[] =>
  (input.touchedModuleSmoke ?? []).map((cmd) => ({
    kind: "module-smoke",
    cmd,
  }))

const reproStepOf = (input: VerificationPlanInput): VerificationStep | undefined =>
  input.reproScript
    ? {
        kind: "repro",
        cmd: input.reproScript.cmd,
        ...(input.reproScript.pytestReportPath !== undefined
          ? { pytestReportPath: input.reproScript.pytestReportPath }
          : {}),
      }
    : undefined

const primaryRailOf = (args: {
  readonly reproStep: VerificationStep | undefined
  readonly baseValidatedRed: boolean
  readonly ownerSteps: readonly VerificationStep[]
  readonly smokeSteps: readonly VerificationStep[]
}): VerificationStep | null =>
  args.reproStep && args.baseValidatedRed
    ? args.reproStep
    : (args.ownerSteps[0] ?? args.smokeSteps[0] ?? null)

const partitionVerificationSteps = (args: {
  readonly ownerSteps: readonly VerificationStep[]
  readonly smokeSteps: readonly VerificationStep[]
  readonly reproStep: VerificationStep | undefined
  readonly primaryRail: VerificationStep | null
  readonly maxRequired: number
}): Pick<VerificationPlan, "required" | "optional"> => {
  const required: VerificationStep[] = []
  const optional: VerificationStep[] = []
  if (args.primaryRail) required.push(args.primaryRail)

  // remaining owner tests fill required up to the cap; the rest are optional.
  for (const s of args.ownerSteps) {
    if (s === args.primaryRail) continue
    if (required.length < args.maxRequired) required.push(s)
    else optional.push(s)
  }
  for (const s of args.smokeSteps) {
    if (s === args.primaryRail) continue
    optional.push(s)
  }
  // a repro that did NOT validate red is demoted to optional — never required.
  if (args.reproStep && args.reproStep !== args.primaryRail) optional.push(args.reproStep)
  return { required, optional }
}

const attachRequiredPredicates = (
  required: VerificationStep[],
  issueDeclaredExpected: VerificationPlanInput["issueDeclaredExpected"],
): void => {
  // Attach a typed successPredicate + authority to every required step. The
  // primary/required step gets the issue-declared exact-output contract when the
  // public problem statement exposes one; the rest default to execution proofs.
  const issueExpected = issueDeclaredExpected
    ? issueExpectedPredicate(issueDeclaredExpected)
    : undefined
  for (let i = 0; i < required.length; i++) {
    const step = required[i]
    if (!step) continue
    if (i === 0 && issueExpected) {
      step.successPredicate = issueExpected.predicate
      step.authority = issueExpected.authority
    } else {
      step.successPredicate = defaultSuccessPredicate(step.kind)
      step.authority = "execution"
    }
  }
}

export const buildVerificationPlan = (input: VerificationPlanInput): VerificationPlan => {
  const maxRequired = input.maxRequired ?? DEFAULT_MAX_REQUIRED
  const baseValidatedRed = input.reproScript?.baseValidatedRed ?? false
  const ownerSteps = ownerStepsOf(input)
  const smokeSteps = smokeStepsOf(input)
  const reproStep = reproStepOf(input)
  // primaryRail authority order: a RED-validated repro > owner-near test > smoke.
  const primaryRail = primaryRailOf({ reproStep, baseValidatedRed, ownerSteps, smokeSteps })
  const { required, optional } = partitionVerificationSteps({
    ownerSteps,
    smokeSteps,
    reproStep,
    primaryRail,
    maxRequired,
  })
  attachRequiredPredicates(required, input.issueDeclaredExpected)

  return { primaryRail, required, optional, baseValidatedRed }
}
