/**
 * b2 — Non-leaking validator (RFC §16, ADR-0014).
 *
 * Re-executes EXACTLY the agent's own last verification command (or, as a
 * fallback, runs the agent-authored reproduction script as `python <path>`) in
 * the patched sandbox. The validator is structurally incapable of peeking at
 * any official dataset hidden field because its sole input contract
 * (`ValidateArgs`) does not expose those — and this file only imports local
 * repair helpers (`./types`, `./repro-outcome`). All I/O is via the INJECTED
 * `exec` port, so the validator is
 * hermetic-by-injection in tests (no node fs / child-process / process spawn
 * reachable from here).
 *
 * Mapping:
 *   - cmd non-empty   ⇒ exec(cmd, sandbox, timeoutMs)
 *   - else reproPath  ⇒ exec(`python "<reproPath>"`, sandbox, timeoutMs)
 *   - else            ⇒ { ok:false, failTail:"" }  (degenerate; NOT a silent pass)
 *
 * Tail bound: default 2000, applied to `stdout + "\n" + stderr` by CHARACTER
 * count (utf-8 codepoints) — chosen for simplicity and stability across both
 * Bun and Node `string.slice`. The tail is taken from the END (the failure
 * tends to be at the tail of test runner output).
 */
import { classifyPytest } from "@/agent/repro-test/execute"
import type { ValidateArgs, ValidatorResult } from "./types"
import { classifyReproOutcome } from "./repro-outcome"

const DEFAULT_TAIL = 2000
const HAS_PYTEST_SUMMARY = /\b(?:\d+\s+failed|\d+\s+errors?|\d+\s+passed|no tests ran)\b/

export const validate = async (args: ValidateArgs): Promise<ValidatorResult> => {
  const tailBound = args.tailBytes ?? DEFAULT_TAIL
  const picked = pickCmd(args)
  if (picked === undefined) {
    // No agent-supplied signal — return a degenerate failure so the outer
    // loop can still iterate or terminate, but never silently "pass".
    return { ok: false, failTail: "" }
  }
  const r = await args.exec(picked.cmd, args.sandbox, args.timeoutMs)

  // T-1: record the observation + typed predicate verdict. The PREDICATE stays
  // observe-only (it never decides `ok`); the `ok` decision is the repro SENTINEL
  // (below) when present, else the legacy exit code. The predicate is fail-open by
  // construction (evaluator returns evaluable:false for anything it can't
  // confidently judge). Recorded for diagnostics / repair seed pressure.
  const observed = { exitCode: r.code, stdout: r.stdout, stderr: r.stderr }
  const predicate =
    args.successPredicate !== undefined && args.evaluatePredicate !== undefined
      ? args.evaluatePredicate(observed, args.successPredicate)
      : undefined

  const combined = `${r.stdout}\n${r.stderr}`
  const failTail = combined.length > tailBound ? combined.slice(-tailBound) : combined
  const reproOutcome = picked.reproAuthority
    ? classifyValidationReproOutcome(r.stdout, r.stderr, r.code)
    : classifyReproOutcome(r.stdout, r.code)
  const ok = (result: boolean): ValidatorResult =>
    result
      ? { ok: true, observed, reproOutcome, ...(predicate !== undefined ? { predicate } : {}) }
      : { ok: false, failTail, observed, reproOutcome, ...(predicate !== undefined ? { predicate } : {}) }

  // P1 (jun-23): a repro is now an execution-grounded pytest test, so the
  // patched resolution check must read the SAME signal as the base-side oracle:
  // pytest pass/fail semantics. For compatibility with older scripted repros we
  // still fall back to the legacy sentinel markers when no pytest summary is
  // present. Non-repro verify commands keep the legacy exit-code decision below.
  if (picked.reproAuthority) {
    if (reproOutcome === "resolved") return ok(true)
    if (reproOutcome === "reproduced" || reproOutcome === "other") return ok(false)
  }

  // No repro sentinel — legacy exit-code decision (byte-identical to pre-fix).
  return ok(r.code === 0)
}

const classifyValidationReproOutcome = (stdout: string, stderr: string, code: number) => {
  const combined = `${stdout}\n${stderr}`
  if (!HAS_PYTEST_SUMMARY.test(combined)) return classifyReproOutcome(stdout, code)
  const pytestOutcome = classifyPytest(stdout, stderr, code)
  return pytestOutcome
}

const pickCmd = (
  args: ValidateArgs,
): { readonly cmd: string; readonly reproAuthority: boolean } | undefined => {
  const cmd = args.cmd ?? ""
  if (cmd !== "") return { cmd, reproAuthority: args.reproAuthority === true }
  const repro = args.reproPath ?? ""
  if (repro !== "") return { cmd: `python "${repro}"`, reproAuthority: true }
  return undefined
}
