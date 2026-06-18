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
 * issue-declared exact output. A REPRO's contract is its Agentless stdout marker
 * ("Issue resolved"), NOT its incidental exit code — so the predicate is
 * `stdout_contains "Issue resolved"`, consistent with both the base reproduction
 * check (classifyStdout) and the validator's sentinel-gating (jun-18 RCA fix).
 * Owner tests and module smoke assert a zero exit.
 */
const defaultSuccessPredicate = (kind: VerificationStep["kind"]): SuccessPredicate =>
  kind === "repro"
    ? { type: "stdout_contains", substring: "Issue resolved" }
    : { type: "test_exit_zero" }

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

  // Attach a typed successPredicate + authority to every required step. The
  // primary/required step gets the issue-declared exact-output contract when the
  // public problem statement exposes one; the rest default to execution proofs.
  const issueExpected = input.issueDeclaredExpected
    ? issueExpectedPredicate(input.issueDeclaredExpected)
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

  return { primaryRail, required, optional, baseValidatedRed }
}
