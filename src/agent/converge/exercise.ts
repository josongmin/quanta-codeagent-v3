/**
 * `@/apps/terminal/verify-gate/exercise` — the L0 "did the deliverable RUN AND get OBSERVED?" layer.
 *
 * A dominant terminal-task failure is "fake green": the agent claims done but never ran
 * its deliverable end-to-end. This layer answers, fail-closed, "does the trajectory contain a tool
 * interaction that RUNS the produced deliverable and OBSERVES its output?" — as opposed to
 * install/build/probe/scaffolding. It ALSO owns the two result predicates every other classifier
 * reuses ({@link resultObservedOutput}, {@link resultRanClean}) so the observation contract has one
 * SSOT (a timed-out or wire-broken result is excluded identically everywhere).
 *
 * PURE / LEAF: input is the captured `AgentEvent[]`; output is a typed verdict.
 */

import type { AgentEvent } from "@/stream"
import {
  ACCEPTANCE_RUNNERS,
  BUILD_OR_INSTALL_TOOLS,
  baseName,
  COMPOUND_SEP,
  CONTAINER_EXEC,
  containerExecCommand,
  INTERPRETERS,
  leaderAndArgs,
  PTY_READ,
  PTY_WRITE,
  ptyPaneCommand,
  ptyWriteData,
  SHELLS,
  TEST_RUNNERS,
  type ToolResultEvent,
} from "./tokenize"

/**
 * True iff an INTERPRETER invocation (`python`, `node`, …) is running the deliverable.
 *
 * A unit because "interpreter" is one dispatch over three mutually-exclusive forms that only make
 * sense read against each other: `-c` is an inline probe, `-m <module>` is whatever that module is
 * (a test runner or a packaging tool — neither is the deliverable), and anything else counts only
 * if it names a file to run. Deciding them at separate call sites is how `python -m pytest` came to
 * read as an exercise and inflate the best-of-N tie-break.
 */
const isInterpreterExercise = (args: readonly string[]): boolean => {
  if (args.includes("-c")) return false // inline snippet / probe, not a run of a produced file
  const mIdx = args.indexOf("-m")
  if (mIdx >= 0) {
    const mod = (args[mIdx + 1] ?? "").toLowerCase()
    if (TEST_RUNNERS.has(mod)) return false // `python -m pytest` = running the suite, not the deliverable
    return ![
      "pip",
      "pip3",
      "venv",
      "virtualenv",
      "ensurepip",
      "build",
      "installer",
      "wheel",
    ].includes(mod)
  }
  return args.some((a) => !a.startsWith("-")) // a non-flag arg = a script/file to run
}

/** True iff a SINGLE command segment affirmatively RUNS the deliverable (fail-closed: anything not
 *  affirmatively an exercise returns false). */
const isExerciseSegment = (segment: string): boolean => {
  const { leader, args } = leaderAndArgs(segment)
  if (leader === "") return false
  const base = baseName(leader)

  // 1. shell wrapper: `bash -c '…'` → classify the INNER command; `bash foo.sh` → running a script.
  if (SHELLS.has(base)) {
    const cIdx = args.findIndex((a) => a === "-c" || a === "-lc" || a === "-ic" || a === "-ilc")
    if (cIdx >= 0) {
      const inner = args
        .slice(cIdx + 1)
        .join(" ")
        .replace(/^['"]|['"]$/g, "")
      return isExerciseCommand(inner)
    }
    return args.some((a) => !a.startsWith("-") && /\.(sh|bash|zsh|ksh)$/.test(a))
  }

  // 2. package managers / build tools / probes → NEVER an exercise (setup, not behavior).
  if (BUILD_OR_INSTALL_TOOLS.has(base)) return false

  // 2b. P2-B: test-RUNNERS (pytest/tox/nose) → NEVER an exercise (runs the suite/hidden oracle, not
  //     the deliverable; and would inflate the best-of-N exercise tie-break).
  if (TEST_RUNNERS.has(base)) return false

  // 3. acceptance / observe runners → exercise (run-and-observe against the deliverable/reference).
  if (ACCEPTANCE_RUNNERS.has(base)) return true

  // 4. interpreter → exercise ONLY when running a FILE (not `-c`, not a pkg-manager `-m`, not a
  //    test-runner `-m pytest`).
  if (INTERPRETERS.has(base)) return isInterpreterExercise(args)

  // 5. a path-invoked leader (`./x`, `/abs/x`, `../x`, `dir/x`) = running a produced artifact —
  //    UNLESS its basename is itself a build/install tool (`/usr/bin/make`).
  if (leader.includes("/")) return !BUILD_OR_INSTALL_TOOLS.has(base)

  // 6. anything else (bare unknown word, `ls`/`cat`/`grep`/`git`/`echo`, scaffolding) → FAIL CLOSED.
  return false
}

/** True iff ANY segment of a (possibly compound `a && b | c ; d`) command is an exercise. Catches
 *  `pip install x && ./run` (the run segment counts) without letting `mkdir x && ls` pass. */
export const isExerciseCommand = (command: string): boolean =>
  command.split(COMPOUND_SEP).some((seg) => seg.trim().length > 0 && isExerciseSegment(seg))

/** A tool result "observed output" when it carries a non-empty stdout preview OR a readable exit
 *  code. An `ok:false` result still counts as an observation — a failing run the agent SAW is
 *  honest evidence (it may finalize as `verified-fail`); what we reject is NO run at all.
 *
 *  B1 (RFC jul-3) TIMEOUT EXCLUSION: a `timedOut` result is NOT an observation — the command was
 *  killed mid-flight, its exit code is a kill sentinel and its output is a truncated prefix. A
 *  timed-out `diff` must never count as an observed L1 comparison (a truncated diff could stamp
 *  `verified-fail`/`verified-pass` on partial evidence); same for L0 run-evidence (fail-closed —
 *  the honest cost is one bounded follow-up). The SINGLE observation predicate — `compare`,
 *  and `self-test` both reuse it (no drifting mirror). */
export const resultObservedOutput = (r: ToolResultEvent): boolean => {
  if (r.timedOut === true) return false
  return (
    (typeof r.preview === "string" && r.preview.trim().length > 0) || typeof r.exitCode === "number"
  )
}

/** True iff a tool_result observed a SUCCESSFUL run: `ok:true` and exit 0.
 *  P1-A (RFC jul-3) FAIL-CLOSED for `container_exec`: that tool ALWAYS surfaces an exit code, so a
 *  `container_exec` result with `exitCode === undefined` means the exitCode WIRE broke — treat it as
 *  NOT clean (else a silently-broken wire would rubber-stamp every crash as a clean run, defeating the
 *  OC1 crash detection this gate exists for). OTHER tools (pty_*, etc.) legitimately surface no exit
 *  code, so for them `undefined` stays tolerant (byte-identical). */
export const resultRanClean = (r: ToolResultEvent): boolean => {
  if (r.ok !== true) return false
  // B1: a deadline kill is never clean regardless of ok/code — belt for a foreign transport that
  // might surface a timed-out run as ok:true (our tool surfaces ok:false, but the predicate must
  // not depend on that courtesy).
  if (r.timedOut === true) return false
  if (r.name === CONTAINER_EXEC) return r.exitCode === 0 // fail-closed: undefined = broken wire
  return r.exitCode === undefined || r.exitCode === 0
}

/** The verdict: did the trajectory exercise the deliverable end-to-end, and (if so) what was the
 *  single most-load-bearing piece of evidence (for the report's `evidence` string)? */
export interface ExerciseVerdict {
  readonly exercised: boolean
  /** One human-readable line naming the interaction that satisfied (or, when `!exercised`, the
   *  reason nothing did). Never leaks a hidden test — it only ever names the model's OWN tool
   *  calls / commands. */
  readonly evidence?: string
}

/** Result facts are indexed before calls are interpreted: a result can arrive
 * after its call, so evidence must not depend on stream ordering. */
type ObservedResultIndex = {
  readonly byCallId: ReadonlyMap<string, boolean>
  readonly ptyReadObserved: boolean
}

const indexObservedResults = (events: readonly AgentEvent[]): ObservedResultIndex => {
  const byCallId = new Map<string, boolean>()
  let ptyReadObserved = false

  for (const event of events) {
    if (event.type !== "tool_result") continue
    const observed = resultObservedOutput(event)
    byCallId.set(event.id, observed)
    if (event.name === PTY_READ && observed) ptyReadObserved = true
  }
  return { byCallId, ptyReadObserved }
}

/** Container execution has its own paired-call contract: an exercise command
 * only proves L0 when that exact call has an observed result. */
const inspectContainerExerciseEvidence = (
  events: readonly AgentEvent[],
  resultObservedById: ReadonlyMap<string, boolean>,
): ExerciseVerdict | undefined => {
  for (const event of events) {
    if (event.type !== "tool_call" || event.name !== CONTAINER_EXEC) continue
    const command = containerExecCommand(event)
    if (
      command !== undefined &&
      isExerciseCommand(command) &&
      resultObservedById.get(event.id) === true
    ) {
      return {
        exercised: true,
        evidence: `container_exec ran the deliverable and observed its output: \`${command.trim().slice(0, 160)}\``,
      }
    }
  }
  return undefined
}

/** A pty session needs a write, a deliverable signal, and a read. This helper
 * deliberately gathers only the first signal, preserving the report's stable
 * evidence line while keeping the parent verdict decision small. */
type PtyExerciseSignals = {
  readonly anyPtyWrite: boolean
  readonly exerciseSignal: string | undefined
}

const inspectPtyExerciseSignals = (events: readonly AgentEvent[]): PtyExerciseSignals => {
  let anyPtyWrite = false
  let exerciseSignal: string | undefined

  for (const event of events) {
    if (event.type !== "tool_call" || !event.name.startsWith("pty_")) continue
    if (event.name === PTY_WRITE) {
      anyPtyWrite = true
      const data = ptyWriteData(event)
      if (data !== undefined && isExerciseCommand(data)) {
        exerciseSignal ??= `pty_write \`${data.trim().slice(0, 120)}\``
      }
      continue
    }
    const paneCommand = ptyPaneCommand(event)
    if (paneCommand !== undefined && isExerciseCommand(paneCommand)) {
      exerciseSignal ??= `pane running \`${paneCommand.trim().slice(0, 120)}\``
    }
  }
  return { anyPtyWrite, exerciseSignal }
}

const ptyExerciseVerdict = (
  signals: PtyExerciseSignals,
  ptyReadObserved: boolean,
): ExerciseVerdict | undefined => {
  if (!signals.anyPtyWrite || signals.exerciseSignal === undefined || !ptyReadObserved)
    return undefined
  return {
    exercised: true,
    evidence: `pty_* session ran the deliverable (${signals.exerciseSignal}) and observed its response (pty_read)`,
  }
}

const noExerciseVerdict = (): ExerciseVerdict => ({
  exercised: false,
  evidence:
    "no end-to-end exercise found: the trajectory only installed/built/inspected artifacts (or drove a shell without running the deliverable) — the deliverable was never run and observed against the task's success criterion",
})

/**
 * Inspect the recorded event stream for evidence of an END-TO-END exercise of the deliverable.
 *
 * Returns `exercised:true` iff EITHER:
 *   (A) a `container_exec` ran an EXERCISE command (per {@link isExerciseCommand}) AND its paired
 *       `tool_result` observed output (stdout / exit code); OR
 *   (B) a `pty_write` TYPED an exercise command AND a `pty_read` observed a response.
 *
 * Fail-closed throughout: install/build/probe/scaffolding and bare-shell chatter never satisfy it.
 */
export const inspectExerciseEvidence = (events: readonly AgentEvent[]): ExerciseVerdict => {
  const observed = indexObservedResults(events)
  const containerVerdict = inspectContainerExerciseEvidence(events, observed.byCallId)
  if (containerVerdict !== undefined) return containerVerdict

  const ptyVerdict = ptyExerciseVerdict(inspectPtyExerciseSignals(events), observed.ptyReadObserved)
  return ptyVerdict ?? noExerciseVerdict()
}
