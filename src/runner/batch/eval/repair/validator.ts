/**
 * b2 — Non-leaking validator (RFC §16, ADR-0014).
 *
 * Re-executes EXACTLY the agent's own last verification command (or, as a
 * fallback, runs the agent-authored reproduction script as `python <path>`) in
 * the patched sandbox. The validator is structurally incapable of peeking at
 * any official dataset hidden field because its sole input contract
 * (`ValidateArgs`) does not expose those — and this file only imports from
 * `./types`. All I/O is via the INJECTED `exec` port, so the validator is
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
import { evaluateSuccessPredicate } from "@/agent/closure"
import type { ExecObservation } from "@/agent/closure"
import type { ValidateArgs, ValidatorResult } from "./types"

const DEFAULT_TAIL = 2000

export const validate = async (args: ValidateArgs): Promise<ValidatorResult> => {
  const tailBound = args.tailBytes ?? DEFAULT_TAIL
  const cmd = pickCmd(args)
  if (cmd === undefined) {
    // No agent-supplied signal — return a degenerate failure so the outer
    // loop can still iterate or terminate, but never silently "pass".
    return { ok: false, failTail: "" }
  }
  const r = await args.exec(cmd, args.sandbox, args.timeoutMs)

  // T-1 OBSERVE-ONLY: record the observation + typed predicate verdict. This NEVER
  // changes `ok` in v1 — the exit-code decision below is byte-identical to before.
  // The predicate is fail-open by construction (evaluator returns evaluable:false
  // for anything it can't confidently judge). Recorded for diagnostics / repair
  // seed pressure; behavior-changing gating is a later ticket gated on measurement.
  const observed: ExecObservation = { exitCode: r.code, stdout: r.stdout, stderr: r.stderr }
  const predicate =
    args.successPredicate !== undefined
      ? evaluateSuccessPredicate(observed, args.successPredicate)
      : undefined

  if (r.code === 0) return { ok: true, observed, ...(predicate !== undefined ? { predicate } : {}) }
  const combined = `${r.stdout}\n${r.stderr}`
  const failTail = combined.length > tailBound ? combined.slice(-tailBound) : combined
  return { ok: false, failTail, observed, ...(predicate !== undefined ? { predicate } : {}) }
}

const pickCmd = (args: ValidateArgs): string | undefined => {
  const cmd = args.cmd ?? ""
  if (cmd !== "") return cmd
  const repro = args.reproPath ?? ""
  if (repro !== "") return `python "${repro}"`
  return undefined
}
