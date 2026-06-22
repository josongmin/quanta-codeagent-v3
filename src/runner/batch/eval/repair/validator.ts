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
import type { ValidateArgs, ValidatorResult } from "./types"
import { classifyReproOutcome } from "./repro-outcome"

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
  const reproOutcome = classifyReproOutcome(r.stdout, r.code)
  const ok = (result: boolean): ValidatorResult =>
    result
      ? { ok: true, observed, reproOutcome, ...(predicate !== undefined ? { predicate } : {}) }
      : { ok: false, failTail, observed, reproOutcome, ...(predicate !== undefined ? { predicate } : {}) }

  // jun-18 RCA fix — REPRO-SENTINEL gating. A repro is an Agentless script whose
  // CONTRACT is the stdout marker ("Issue resolved"/"reproduced"/"Other issues"),
  // not its incidental exit code. The base reproduction check classifies by the
  // SAME `classifyStdout` marker — so the patched resolution check MUST be
  // consistent, else a repro that prints "Issue resolved" but exits ≠0 (a
  // warning-turned-error, post-marker cleanup, …) is a FALSE-RED that forces
  // wasteful repair churn (measured: 46→131 turns re-deriving the same correct
  // patch). When a marker is present the marker decides; a non-repro verify cmd
  // (pytest, …) carries no marker ⇒ classifyStdout is unknown/exec_failed ⇒ the
  // legacy exit-code decision below is byte-identical.
  if (picked.reproAuthority) {
    if (reproOutcome === "resolved") return ok(true)
    if (reproOutcome === "reproduced" || reproOutcome === "other") return ok(false)
  }

  // No repro sentinel — legacy exit-code decision (byte-identical to pre-fix).
  return ok(r.code === 0)
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
