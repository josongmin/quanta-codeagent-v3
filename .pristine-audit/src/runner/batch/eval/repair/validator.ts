/**
 * b2 — Non-leaking validator (RFC §16, ADR-0014).
 *
 * Re-executes EXACTLY the agent's own last verification command (or an explicit
 * adapter-supplied reproduction command) in the patched sandbox. The validator
 * is structurally incapable of peeking at
 * any official dataset hidden field because its sole input contract
 * (`ValidateArgs`) does not expose those — and this file only imports local
 * repair helpers (`./types`, `./pytest-report`). All I/O is via the INJECTED
 * `exec` port, so the validator is
 * hermetic-by-injection in tests (no node fs / child-process / process spawn
 * reachable from here).
 *
 * Mapping:
 *   - cmd non-empty   ⇒ exec(cmd, sandbox, timeoutMs)
 *   - else reproCmd   ⇒ exec(reproCmd, sandbox, timeoutMs)
 *   - else reproPath  ⇒ no runnable gate; path-only cannot define interpreter
 *   - else            ⇒ { ok:false, failTail:"" }  (degenerate; NOT a silent pass)
 *
 * Tail bound: default 2000, applied to `stdout + "\n" + stderr` by CHARACTER
 * count (utf-8 codepoints) — chosen for simplicity and stability across both
 * Bun and Node `string.slice`. The tail is taken from the END (the failure
 * tends to be at the tail of test runner output).
 */
import { classifyPytestReportText, pytestReportPathFor } from "./pytest-report"
import { buildValidationFailureEvidence, type ValidateArgs, type ValidatorResult } from "./types"

const DEFAULT_TAIL = 2000

export const validate = async (args: ValidateArgs): Promise<ValidatorResult> => {
  const tailBound = args.tailBytes ?? DEFAULT_TAIL
  const picked = pickCmd(args)
  if (picked === undefined) {
    // No agent-supplied signal — return a degenerate failure so the outer
    // loop can still iterate or terminate, but never silently "pass".
    return { ok: false, failTail: "" }
  }
  const r = await args.exec(picked.cmd, args.sandbox, args.timeoutMs)

  // T-1: record the observation + typed predicate verdict. The predicate stays
  // observe-only (it never decides `ok`). A repro-authority command is decided
  // solely by the controlled pytest sidecar; non-repro validation commands keep
  // the command exit-code contract. Recorded for diagnostics / repair seed
  // pressure only.
  const observed = { exitCode: r.code, stdout: r.stdout, stderr: r.stderr }
  const predicate =
    args.successPredicate !== undefined && args.evaluatePredicate !== undefined
      ? args.evaluatePredicate(observed, args.successPredicate)
      : undefined

  const failureEvidence = buildValidationFailureEvidence({
    stdout: r.stdout,
    stderr: r.stderr,
    tailBytes: tailBound,
  })
  const reproOutcome = picked.reproAuthority
    ? await classifyValidationReproOutcome(args, picked)
    : undefined
  const reproOutcomeField = reproOutcome !== undefined ? { reproOutcome } : {}
  const ok = (result: boolean): ValidatorResult =>
    result
      ? {
          ok: true,
          observed,
          ...reproOutcomeField,
          ...(predicate !== undefined ? { predicate } : {}),
        }
      : {
          ok: false,
          failTail: failureEvidence.combinedTail,
          failureEvidence,
          observed,
          ...reproOutcomeField,
          ...(predicate !== undefined ? { predicate } : {}),
        }

  // Repro authority is the controlled pytest sidecar only. No stdout marker or
  // output summary is allowed to green/red a proof rail.
  if (picked.reproAuthority) {
    if (reproOutcome === "resolved") return ok(true)
    if (reproOutcome === "reproduced" || reproOutcome === "other") return ok(false)
    return ok(false)
  }

  // Non-repro validation command: use its process exit code.
  return ok(r.code === 0)
}

const classifyValidationReproOutcome = async (
  args: ValidateArgs,
  picked: { readonly pytestReportPath?: string; readonly reproPath?: string },
) => {
  const reportPath = picked.pytestReportPath ?? reproReportPathFrom(picked.reproPath)
  if (args.readFile === undefined || reportPath === undefined) return "exec_failed"
  try {
    return classifyPytestReportText(await args.readFile(reportPath))
  } catch {
    return "exec_failed"
  }
}

const reproReportPathFrom = (reproPath: string | undefined): string | undefined =>
  reproPath === undefined || reproPath === "" ? undefined : pytestReportPathFor(reproPath)

const pickCmd = (
  args: ValidateArgs,
):
  | {
      readonly cmd: string
      readonly reproAuthority: boolean
      readonly reproPath?: string
      readonly pytestReportPath?: string
    }
  | undefined => {
  const cmd = args.cmd ?? ""
  if (cmd !== "")
    return {
      cmd,
      reproAuthority: args.reproAuthority === true,
      ...(args.reproPath !== undefined ? { reproPath: args.reproPath } : {}),
      ...(args.pytestReportPath !== undefined ? { pytestReportPath: args.pytestReportPath } : {}),
    }
  const reproCmd = args.reproCmd ?? ""
  if (reproCmd !== "")
    return {
      cmd: reproCmd,
      reproAuthority: true,
      ...(args.reproPath !== undefined ? { reproPath: args.reproPath } : {}),
      ...(args.pytestReportPath !== undefined ? { pytestReportPath: args.pytestReportPath } : {}),
    }
  return undefined
}
