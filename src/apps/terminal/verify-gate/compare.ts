/**
 * `@/apps/terminal/verify-gate/compare` — the L1 "was the output CHECKED against a reference?" layer.
 *
 * L0 (ran+observed) is NECESSARY but NOT SUFFICIENT for `verified-pass` — v1's bug was stamping a
 * mere run as green ("ran it, declared green, never compared"). L1 requires an OBSERVED comparison:
 * a `diff`/`cmp`/… of TWO DISTINCT non-test artifacts, OR a script run referencing both an output
 * AND a reference operand, whose paired `tool_result` observed output. Fail-closed + no-leak: a
 * reference under a verifier/test path — or one LAUNDERED from it (P2-C taint) — is REFUSED via the
 * shared {@link isUnfair} predicate from the oracle-taint SSOT.
 *
 * PURE / LEAF.
 */

import type { AgentEvent } from "@/stream"
import { resultObservedOutput } from "./exercise"
import { buildTaintedRefs, isUnfair } from "./oracle-taint"
import {
  baseName,
  COMPOUND_SEP,
  CONTAINER_EXEC,
  containerExecCommand,
  INTERPRETERS,
  leaderAndArgs,
  PTY_READ,
  PTY_WRITE,
  ptyWriteData,
  SHELLS,
} from "./tokenize"

/** The COMPARATOR leaders whose job IS to diff two artifacts. Two distinct non-test operands ⇒ L1. */
const COMPARATORS: ReadonlySet<string> = new Set(["diff", "cmp", "sdiff", "colordiff"])

/** A non-flag, non-redirection token that looks like a filesystem operand (has a slash, an extension,
 *  or is a plain word) — used to count the DISTINCT operands a comparator was handed. Excludes the
 *  `/dev/null` sink (R4: `diff /dev/null /dev/null` is not a real comparison). */
const isPathOperand = (tok: string): boolean => {
  if (tok.startsWith("-")) return false // a flag (`-u`, `--brief`)
  if (tok === "" || tok === "<" || tok === ">" || tok === ">>" || tok === "|") return false
  if (/^\/dev\/(null|zero|stdin|stdout)$/i.test(tok)) return false // not a real artifact
  return true
}

/** Reference-shaped flag/operand names a comparison SCRIPT uses to name its oracle (R: script L1).
 *  Matches an explicit compare FLAG (`--expected`/`--reference`/…) OR a reference-shaped WORD in a
 *  filename (`baseline`/`reference`/`expected`/`original`/`golden`/`oracle`/`truth`/a trailing
 *  `_ref`). This is the honest "this operand IS the reference" signal — a bare `out.json` `in.json`
 *  run of the solver (no such signal) is NOT a comparison (fail-closed; costs one follow-up). */
const REFERENCE_HINT =
  /(--expected\b|--reference\b|--baseline\b|--golden\b|--oracle\b|--truth\b|--gold\b|--ref\b|expected[_-]?(output|value|result)|baseline|reference|original|golden|oracle|truth|[_-]ref\b|\bref[_./-])/i

/** Result of judging ONE command segment for an L1 comparison. `refIsTestPath` distinguishes the
 *  fail-closed reject (a comparison AGAINST an unfair reference — recognized-but-refused) from "no
 *  comparison at all", so the caller can keep the honest "never compared" reason. */
interface SegmentL1 {
  readonly isCompare: boolean
  readonly refIsTestPath: boolean
}

/** Judge a SINGLE command segment for an L1 comparison (pure, fail-closed). `unfair` is the
 *  operand-refusal predicate — R1 path markers + P2-C laundering taint (from {@link buildTaintedRefs}). */
const segmentComparesToReference = (
  segment: string,
  unfair: (operand: string) => boolean,
): SegmentL1 => {
  const { leader, args } = leaderAndArgs(segment)
  if (leader === "") return { isCompare: false, refIsTestPath: false }
  const base = baseName(leader)

  // shell wrapper: `bash -c '…'` → judge the INNER command (the actual comparison runs there).
  if (SHELLS.has(base)) {
    const cIdx = args.findIndex((a) => a === "-c" || a === "-lc" || a === "-ic" || a === "-ilc")
    if (cIdx >= 0) {
      const inner = args
        .slice(cIdx + 1)
        .join(" ")
        .replace(/^['"]|['"]$/g, "")
      return anySegmentComparesToReference(inner, unfair)
    }
    return { isCompare: false, refIsTestPath: false }
  }

  // (1) a COMPARATOR (`diff`/`cmp`/`sdiff`/`colordiff`) with TWO DISTINCT real operands.
  if (COMPARATORS.has(base)) {
    const operands = args.filter(isPathOperand)
    const distinct = [...new Set(operands)]
    if (distinct.length < 2) return { isCompare: false, refIsTestPath: false } // R4: `diff a a`, <2 operands
    // no-leak (R1 + P2-C): if ANY operand is under a verifier/test path — or received its content
    // FROM one (laundering taint) — this is NOT a fair L1 comparison.
    if (distinct.some(unfair)) return { isCompare: false, refIsTestPath: true }
    return { isCompare: true, refIsTestPath: false }
  }

  // (2) an interpreter/script run that references a reference-shaped operand OR two data artifacts —
  //     e.g. `python check.py out.npy --expected ref.npy` or `node cmp.js a.json b.json`.
  if (INTERPRETERS.has(base) || leader.includes("/")) {
    if (args.includes("-c")) return { isCompare: false, refIsTestPath: false } // inline probe, not a run
    const operands = args.filter(isPathOperand)
    // A script is L1 ONLY when it NAMES its reference — an explicit compare flag
    // (`--expected`/`--reference`/…) OR a reference-shaped operand name (`baseline.json`,
    // `ref.npy`, `expected_output.txt`). A bare `solve.py in.json out.json` names no reference ⇒
    // it is an L0 RUN, NOT a comparison (fail-closed — this is the mini-rubber-stamp v2 must not
    // re-open: two data files alone do NOT prove a compare happened).
    const namesReference = args.some((a) => REFERENCE_HINT.test(a))
    if (!namesReference) return { isCompare: false, refIsTestPath: false }
    // no-leak (R1 + P2-C): neither the SCRIPT ITSELF nor any operand may be under a verifier/test
    // path — RUNNING the hidden verifier/grader script (`python /app/tests/verify.py …`) is peeking
    // too, even when the compared operands look clean — nor oracle-DERIVED (tainted).
    if (unfair(leader) || operands.some(unfair)) return { isCompare: false, refIsTestPath: true }
    return { isCompare: true, refIsTestPath: false }
  }

  return { isCompare: false, refIsTestPath: false }
}

/** Judge a (possibly compound) command for an L1 comparison in ANY segment. `unfair` is REQUIRED
 *  (every caller threads the taint-aware predicate — a default would silently drop normalization
 *  + taint and re-open the laundering hole). */
const anySegmentComparesToReference = (
  command: string,
  unfair: (operand: string) => boolean,
): SegmentL1 => {
  let refIsTestPath = false
  for (const seg of command.split(COMPOUND_SEP)) {
    if (seg.trim().length === 0) continue
    const r = segmentComparesToReference(seg, unfair)
    if (r.isCompare) return { isCompare: true, refIsTestPath: false }
    if (r.refIsTestPath) refIsTestPath = true
  }
  return { isCompare: false, refIsTestPath }
}

/** The L1 verdict: did the trajectory OBSERVE a comparison of its output against a reference? */
export interface CompareVerdict {
  /** True iff an observed L1 comparison (per §03) was found — the sole path to `verified-pass`. */
  readonly compared: boolean
  /** True iff the ONLY comparison(s) found were UNFAIR — a reference under a verifier/test path
   *  (R1) OR a file that received oracle content via laundering (P2-C taint). Distinguishes
   *  "peeked at the hidden oracle (directly or laundered)" from "never compared" for honest
   *  evidence. */
  readonly refusedTestPath: boolean
  /** One human-readable line naming the model's OWN comparison command (never a hidden test). */
  readonly evidence?: string
}

/**
 * PURE L1 inspector (RFC jul-2 §03). Returns `compared:true` iff the trajectory contains an OBSERVED
 * comparison of the deliverable's output against a DISTINCT, non-test reference — a comparator
 * (`diff`/`cmp`/`sdiff`/`colordiff`) of two distinct non-test operands, OR a script run referencing
 * both an output and a reference operand — whose paired `tool_result` observed output.
 *
 * Fail-closed + no-leak: `diff a a` / `<2 operands` / `/dev/null` sinks / bare `echo matches` never
 * count (R4); a comparison whose reference is under a verifier/test path OR laundered from one is
 * REFUSED — recognized but rejected, surfaced via `refusedTestPath` so the gate can never teach peeking.
 */
export const comparedToReference = (events: readonly AgentEvent[]): CompareVerdict => {
  const resultObservedById = new Map<string, boolean>()
  let ptyReadObserved = false
  const ownCommands: string[] = []
  for (const ev of events) {
    if (ev.type === "tool_result") {
      resultObservedById.set(ev.id, resultObservedOutput(ev))
      if (ev.name === PTY_READ && resultObservedOutput(ev)) ptyReadObserved = true
    } else if (ev.type === "tool_call") {
      if (ev.name === CONTAINER_EXEC) {
        const c = containerExecCommand(ev)
        if (c !== undefined) ownCommands.push(c)
      } else if (ev.name === PTY_WRITE) {
        const d = ptyWriteData(ev)
        if (d !== undefined) ownCommands.push(d)
      }
    }
  }
  // P2-C: taint pre-pass over the model's OWN commands — a compare operand that RECEIVED oracle
  // content (cp/ln/mv/tee/redirect laundering, transitively) is refused like the oracle itself.
  const tainted = buildTaintedRefs(ownCommands)
  const unfair = (operand: string): boolean => isUnfair(operand, tainted)

  let refusedTestPath = false
  for (const ev of events) {
    if (ev.type !== "tool_call") continue
    if (ev.name === CONTAINER_EXEC) {
      const command = containerExecCommand(ev)
      if (command === undefined) continue
      const r = anySegmentComparesToReference(command, unfair)
      if (r.refIsTestPath) refusedTestPath = true
      if (r.isCompare && resultObservedById.get(ev.id) === true) {
        return {
          compared: true,
          refusedTestPath: false,
          evidence: `compared output to a reference and observed the result: \`${command.trim().slice(0, 160)}\``,
        }
      }
    } else if (ev.name === PTY_WRITE) {
      const data = ptyWriteData(ev)
      if (data === undefined) continue
      const r = anySegmentComparesToReference(data, unfair)
      if (r.refIsTestPath) refusedTestPath = true
      // A comparison TYPED into a pane counts only when the pane response was observed (a pty_read).
      if (r.isCompare && ptyReadObserved) {
        return {
          compared: true,
          refusedTestPath: false,
          evidence: `compared output to a reference in a pane and observed the result: \`${data.trim().slice(0, 160)}\``,
        }
      }
    }
  }

  return {
    compared: false,
    refusedTestPath,
    evidence: refusedTestPath
      ? "no fair comparison found: the only comparison referenced a verifier/test path or a file derived from one (refused — the gate never peeks at a hidden oracle)"
      : "no comparison found: the deliverable's output was never diffed/checked against a task-provided reference",
  }
}
