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
  type ToolCallEvent,
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

/** The three verdicts a segment judge can reach. Named once so the three category judges below
 *  cannot drift apart on the shape they return (the pre-split code spelled each literal six times). */
const NOT_A_COMPARISON: SegmentL1 = { isCompare: false, refIsTestPath: false }
const FAIR_COMPARISON: SegmentL1 = { isCompare: true, refIsTestPath: false }
/** Recognized as a comparison, REFUSED because an operand is unfair (R1 path / P2-C taint). */
const REFUSED_UNFAIR: SegmentL1 = { isCompare: false, refIsTestPath: true }

/** The `-c`-style flags that make a shell take its command from the NEXT argument. */
const SHELL_COMMAND_FLAGS: ReadonlySet<string> = new Set(["-c", "-lc", "-ic", "-ilc"])

/** Category (a) — a shell wrapper (`bash -c '…'`): judge the INNER command, since the actual
 *  comparison runs there. A shell with no `-c` flag carries no inline command ⇒ not a comparison. */
const judgeShellWrapper = (
  args: readonly string[],
  unfair: (operand: string) => boolean,
): SegmentL1 => {
  const cIdx = args.findIndex((a) => SHELL_COMMAND_FLAGS.has(a))
  if (cIdx < 0) return NOT_A_COMPARISON
  const inner = args
    .slice(cIdx + 1)
    .join(" ")
    .replace(/^['"]|['"]$/g, "")
  return anySegmentComparesToReference(inner, unfair)
}

/** Category (b) — a COMPARATOR (`diff`/`cmp`/`sdiff`/`colordiff`) with TWO DISTINCT real operands.
 *  R4 rejects `diff a a` / `<2 operands` / `/dev/null` sinks; no-leak (R1 + P2-C) refuses when ANY
 *  operand is under a verifier/test path or received its content FROM one (laundering taint). */
const judgeComparator = (
  args: readonly string[],
  unfair: (operand: string) => boolean,
): SegmentL1 => {
  const distinct = [...new Set(args.filter(isPathOperand))]
  if (distinct.length < 2) return NOT_A_COMPARISON
  if (distinct.some(unfair)) return REFUSED_UNFAIR
  return FAIR_COMPARISON
}

/** Category (c) — an interpreter/script run that NAMES its reference — e.g.
 *  `python check.py out.npy --expected ref.npy`. A bare `solve.py in.json out.json` names no
 *  reference ⇒ it is an L0 RUN, not a comparison (fail-closed — the mini-rubber-stamp v2 must not
 *  re-open: two data files alone do NOT prove a compare happened). `-c` is an inline probe, not a
 *  run. No-leak (R1 + P2-C): neither the SCRIPT ITSELF nor any operand may be under a verifier/test
 *  path — RUNNING the hidden verifier (`python /app/tests/verify.py …`) is peeking too, even when
 *  the compared operands look clean — nor oracle-DERIVED (tainted). */
const judgeScriptRun = (
  leader: string,
  args: readonly string[],
  unfair: (operand: string) => boolean,
): SegmentL1 => {
  if (args.includes("-c")) return NOT_A_COMPARISON
  if (!args.some((a) => REFERENCE_HINT.test(a))) return NOT_A_COMPARISON
  if (unfair(leader) || args.filter(isPathOperand).some(unfair)) return REFUSED_UNFAIR
  return FAIR_COMPARISON
}

/** Judge a SINGLE command segment for an L1 comparison (pure, fail-closed). `unfair` is the
 *  operand-refusal predicate — R1 path markers + P2-C laundering taint (from {@link buildTaintedRefs}).
 *  Pure DISPATCH: the leader's basename selects exactly one of the three category judges above. */
const segmentComparesToReference = (
  segment: string,
  unfair: (operand: string) => boolean,
): SegmentL1 => {
  const { leader, args } = leaderAndArgs(segment)
  if (leader === "") return NOT_A_COMPARISON
  const base = baseName(leader)
  if (SHELLS.has(base)) return judgeShellWrapper(args, unfair)
  if (COMPARATORS.has(base)) return judgeComparator(args, unfair)
  if (INTERPRETERS.has(base) || leader.includes("/")) return judgeScriptRun(leader, args, unfair)
  return NOT_A_COMPARISON
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
    if (r.isCompare) return FAIR_COMPARISON
    if (r.refIsTestPath) refIsTestPath = true
  }
  return refIsTestPath ? REFUSED_UNFAIR : NOT_A_COMPARISON
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

/** What the trajectory OBSERVED, harvested in ONE pass: which `tool_result` ids carried observed
 *  output, whether a `pty_read` was observed at all, and the model's OWN issued commands (in event
 *  order) for the P2-C taint pre-pass. */
interface Observations {
  readonly resultObservedById: ReadonlyMap<string, boolean>
  readonly ptyReadObserved: boolean
  readonly ownCommands: readonly string[]
}

/**
 * The TWO command-carrying surfaces this gate inspects, as a TABLE. Each row owns the three things
 * that used to be spelled out twice per pass in `comparedToReference`:
 *   - `extract` — how to pull the issued command out of that tool's `input`;
 *   - `observed` — what counts as HAVING SEEN the result (a `container_exec` needs its OWN paired
 *     `tool_result` to have observed output; a `pty_write` is typed into a pane, so the observation
 *     is any observed `pty_read` anywhere in the trajectory);
 *   - `evidence` — the human-readable line naming the model's own comparison command.
 * Adding a third surface is a row, not a fourth copy of the branch tail.
 */
interface CommandSurface {
  readonly extract: (call: ToolCallEvent) => string | undefined
  readonly observed: (call: ToolCallEvent, obs: Observations) => boolean
  readonly evidence: (command: string) => string
}

const COMMAND_SURFACES: Readonly<Record<string, CommandSurface>> = {
  [CONTAINER_EXEC]: {
    extract: containerExecCommand,
    observed: (call, obs) => obs.resultObservedById.get(call.id) === true,
    evidence: (command) =>
      `compared output to a reference and observed the result: \`${command.trim().slice(0, 160)}\``,
  },
  [PTY_WRITE]: {
    extract: ptyWriteData,
    observed: (_call, obs) => obs.ptyReadObserved,
    evidence: (command) =>
      `compared output to a reference in a pane and observed the result: \`${command.trim().slice(0, 160)}\``,
  },
}

/** Pass 1 — harvest {@link Observations}. Pure fold over the event list; no judging happens here. */
const collectObservations = (events: readonly AgentEvent[]): Observations => {
  const resultObservedById = new Map<string, boolean>()
  let ptyReadObserved = false
  const ownCommands: string[] = []
  for (const ev of events) {
    if (ev.type === "tool_result") {
      const observed = resultObservedOutput(ev)
      resultObservedById.set(ev.id, observed)
      if (ev.name === PTY_READ && observed) ptyReadObserved = true
      continue
    }
    if (ev.type !== "tool_call") continue
    const command = COMMAND_SURFACES[ev.name]?.extract(ev)
    if (command !== undefined) ownCommands.push(command)
  }
  return { resultObservedById, ptyReadObserved, ownCommands }
}

/** Pass 2 — walk the SAME events in order and return the FIRST fair, observed comparison, or record
 *  that the only comparison(s) found were unfair. One loop body serves both surfaces (the table
 *  supplies the extraction, the observation rule, and the evidence phrasing). */
const findObservedComparison = (
  events: readonly AgentEvent[],
  obs: Observations,
  unfair: (operand: string) => boolean,
): CompareVerdict => {
  let refusedTestPath = false
  for (const ev of events) {
    if (ev.type !== "tool_call") continue
    const surface = COMMAND_SURFACES[ev.name]
    if (surface === undefined) continue
    const command = surface.extract(ev)
    if (command === undefined) continue
    const r = anySegmentComparesToReference(command, unfair)
    if (r.refIsTestPath) refusedTestPath = true
    if (r.isCompare && surface.observed(ev, obs)) {
      return { compared: true, refusedTestPath: false, evidence: surface.evidence(command) }
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

/**
 * PURE L1 inspector (RFC jul-2 §03). Returns `compared:true` iff the trajectory contains an OBSERVED
 * comparison of the deliverable's output against a DISTINCT, non-test reference — a comparator
 * (`diff`/`cmp`/`sdiff`/`colordiff`) of two distinct non-test operands, OR a script run referencing
 * both an output and a reference operand — whose paired `tool_result` observed output.
 *
 * Fail-closed + no-leak: `diff a a` / `<2 operands` / `/dev/null` sinks / bare `echo matches` never
 * count (R4); a comparison whose reference is under a verifier/test path OR laundered from one is
 * REFUSED — recognized but rejected, surfaced via `refusedTestPath` so the gate can never teach peeking.
 *
 * Three phases, one each: observe → taint → judge.
 */
export const comparedToReference = (events: readonly AgentEvent[]): CompareVerdict => {
  const obs = collectObservations(events)
  // P2-C: taint pre-pass over the model's OWN commands — a compare operand that RECEIVED oracle
  // content (cp/ln/mv/tee/redirect laundering, transitively) is refused like the oracle itself.
  const tainted = buildTaintedRefs(obs.ownCommands)
  return findObservedComparison(events, obs, (operand) => isUnfair(operand, tainted))
}
