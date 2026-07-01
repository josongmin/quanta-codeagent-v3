/**
 * `@/apps/terminal/verify-gate` — the terminal "verify-before-finalize" evidence inspector
 * (Lever #2, RFC `jul-2-terminal-bench-levers/02-verify-before-finalize-rfc.md`).
 *
 * PURPOSE. The dominant Terminal-Bench failure (~70% of failures) is "fake green": the agent
 * emits a final report claiming *implemented / verified / green* but never exercised its
 * deliverable end-to-end against the task's real acceptance criterion — it proved
 * *existence / execution* ("the file exists", "it compiled", "it ran once"), not *behavior
 * against spec* ("the output matches the reference"). This module is a PURE inspection over the
 * recorded agent event stream that asks a single, conservative question: does the trajectory
 * contain at least one tool interaction that both (a) RUNS the produced deliverable and
 * (b) OBSERVES its output/behavior — as opposed to merely creating, listing, or reading a file?
 *
 * WHY A NEW TERMINAL-SPECIFIC CLASSIFIER (not the existing `verify-guard`). The SWE-bench
 * `verify-guard` (`src/agent/verify-guard.ts`) recognizes ONLY the `test_runner` tool or a
 * `bash` command matching a test regex, and its "mutating" notion is FS edit tools. The terminal
 * brain surface has NONE of those tools — no `bash`, no `test_runner`, no FS-edit tools; only
 * `container_exec` + `pty_*` (`src/apps/terminal/index.ts:37`). So the exercise contract MUST be
 * expressed over THIS surface's tools. This is honestly new work, with `verify-guard` as a
 * *philosophical* reference (sticky-red "don't accept until verified"), NOT a code dependency.
 *
 * BOTH TOOLS COUNT (review P1). The surface deliberately routes interactive work (REPL / TUI /
 * long-lived server) to `pty_*` while one-shot commands go to `container_exec`
 * (`src/tool/terminal-capability-guide.ts:23`). A `container_exec`-only inspector would mis-flag
 * a genuinely-exercised REPL / TUI / server as unverified. Evidence is counted from EITHER tool:
 *   - `container_exec` that RUNS the deliverable AND its result carries observed output; or
 *   - a `pty_*` session that DRIVES the interactive deliverable (a `pty_write`) AND OBSERVES its
 *     response (a `pty_read` returning output).
 *
 * CONSERVATIVE + DOCUMENTED HEURISTIC. We deliberately under-claim rather than over-claim (a
 * false "exercised:true" defeats the gate; a false "exercised:false" only costs one bounded
 * follow-up turn, which is cheap and honest):
 *   - `container_exec`: a command is an EXERCISE only when it is NOT purely a scaffolding /
 *     inspection command (see {@link NON_EXERCISE_LEADERS}: mkdir / ls / cat / echo / touch /
 *     cd / cp / mv / rm / pwd / which / chmod / mkfifo / …) AND the tool result carried some
 *     observed output (a non-empty `preview`, OR an `exitCode` we could read — running the thing
 *     and reading its exit code / stdout is the observation). "Created a file" and "listed a
 *     directory" are NOT exercises; "ran ./build/mystery and read its stdout" IS.
 *   - `pty_*`: at least one `pty_write` (drove the interactive deliverable) AND at least one
 *     `pty_read` whose result carried observed output (read the program's response). Attaching a
 *     pane alone, or writing without ever reading back, is NOT an exercise.
 *
 * PURE / LEAF. No model calls, no IO, no `process.*`. Input is the captured `AgentEvent[]`;
 * output is a small typed verdict. This keeps the gate's decision unit-testable and deterministic.
 */

import type { AgentEvent } from "@/stream"

/** The terminal surface's interactive tool family (`src/tool/pty/tools.ts`). Any tool whose name
 *  begins with `pty_` is a PTY interaction; the two we score are `pty_write` (drive) and
 *  `pty_read` (observe). */
const PTY_WRITE = "pty_write"
const PTY_READ = "pty_read"
const CONTAINER_EXEC = "container_exec"

/**
 * Command LEADERS (the first shell token) that, on their own, are scaffolding / inspection — NOT
 * an end-to-end exercise of a produced deliverable. Running one of these proves *existence* or
 * *setup*, never *behavior against spec*. Kept conservative and DOCUMENTED: the set is the common
 * filesystem-plumbing verbs the "fake green" finals leaned on ("I created the file / listed the
 * dir / cat'd the artifact"). Anything NOT in this set (running a binary, a script, a server, a
 * test harness the task itself specified, a diff against a reference) is treated as a candidate
 * exercise. We match on the FIRST bare token only (see {@link firstCommandLeader}).
 */
const NON_EXERCISE_LEADERS: ReadonlySet<string> = new Set([
  "mkdir",
  "rmdir",
  "ls",
  "ll",
  "dir",
  "cat",
  "echo",
  "printf",
  "touch",
  "cd",
  "pwd",
  "cp",
  "mv",
  "rm",
  "ln",
  "chmod",
  "chown",
  "which",
  "command", // `command -v foo` — a PATH probe, not an exercise
  "type",
  "mkfifo",
  "mktemp",
  "true",
  "false",
  "export",
  "set",
  "unset",
  "head", // reading a file's head/tail is inspection, not exercising the deliverable
  "tail",
  "wc",
  "stat",
  "file",
  "tree",
  "find", // locating files is inspection
  "git", // `git status`/`git add` is repo plumbing — the exact "noise verify" escape the SWE-bench
  //         verify-guard was tightened against (a `git status` was wrongly treated as "verified").
  "grep", // searching source is inspection, not running the deliverable
  "sed",
  "awk",
  "sleep",
  "clear",
])

/** The verdict: did the trajectory exercise the deliverable end-to-end, and (if so) what was the
 *  single most-load-bearing piece of evidence (for the report's `evidence` string)? */
export interface ExerciseVerdict {
  readonly exercised: boolean
  /** One human-readable line naming the interaction that satisfied (or, when `!exercised`, the
   *  reason nothing did). Never leaks a hidden test — it only ever names the model's OWN tool
   *  calls / commands. */
  readonly evidence?: string
}

/** Narrowed views over the two AgentEvent shapes we read. */
type ToolCallEvent = Extract<AgentEvent, { type: "tool_call" }>
type ToolResultEvent = Extract<AgentEvent, { type: "tool_result" }>

/** The first bare shell token of a command string, lower-cased, with a leading env-assignment
 *  prefix (`FOO=bar cmd`), `sudo`, and a `./`/absolute path stripped so `./build/mystery` and
 *  `/app/mystery` both reduce to the RUN of a produced artifact (NOT a scaffolding leader). A
 *  command whose real leader is a path to a produced binary is therefore NOT filtered out. */
const firstCommandLeader = (command: string): string => {
  const tokens = command.trim().split(/\s+/)
  let i = 0
  // skip leading `VAR=value` assignments and a `sudo`/`env` wrapper
  while (i < tokens.length) {
    const t = tokens[i]
    if (t === undefined) break
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t === "sudo" || t === "env") {
      i += 1
      continue
    }
    break
  }
  // A path invocation (`./x`, `/abs/x`, `../x`, `bin/x`) is a RUN of a produced artifact — its
  // leader contains `/`, so it is never in NON_EXERCISE_LEADERS and always counts as a candidate
  // exercise. A bare word (`ls`, `mystery`) is compared against the scaffolding set as-is.
  return (tokens[i] ?? "").toLowerCase()
}

/** True when a `container_exec` command, on its own, is scaffolding/inspection (NOT an exercise).
 *  Reads the first meaningful leader; a compound command (`a && b`) is judged by its FIRST leader
 *  conservatively — if the first thing it does is scaffolding we still let a later run count via a
 *  DIFFERENT tool call, but a single `mkdir -p x` call is correctly excluded. A leader with a path
 *  (running a produced binary) is never in the non-exercise set, so it always counts. */
const isNonExerciseCommand = (command: string): boolean => {
  const lead = firstCommandLeader(command)
  if (lead === "") return true // empty / whitespace command observes nothing
  // A `/`-containing leader (a produced-artifact run) is never in the set → counts as an exercise.
  return NON_EXERCISE_LEADERS.has(lead)
}

/** A tool result "observed output" when it carries a non-empty stdout preview OR a readable exit
 *  code (running the deliverable and reading its exit code / stdout IS the observation the gate
 *  wants). An `ok:false` result still counts as an observation — a failing run that the agent SAW
 *  is honest evidence (it may finalize as `verified-fail`); what we reject is NO run at all. */
const resultObservedOutput = (r: ToolResultEvent): boolean =>
  (typeof r.preview === "string" && r.preview.trim().length > 0) || typeof r.exitCode === "number"

/** Extract the command string a `container_exec` tool_call carried (its input is `{ command }`).
 *  Defensive: unknown-shaped input yields `undefined` (no crash on a malformed event). */
const containerExecCommand = (call: ToolCallEvent): string | undefined => {
  const input = call.input
  if (input !== null && typeof input === "object" && "command" in input) {
    const c = (input as { command?: unknown }).command
    if (typeof c === "string") return c
  }
  return undefined
}

/**
 * Inspect the recorded event stream for evidence of an END-TO-END exercise of the deliverable.
 *
 * Returns `exercised:true` iff EITHER:
 *   (A) a `container_exec` ran a NON-scaffolding command (per {@link isNonExerciseCommand}) AND
 *       its paired `tool_result` observed output (stdout / exit code); OR
 *   (B) a `pty_write` drove an interactive program AND a `pty_read` observed its response.
 *
 * The pairing is by tool-call `id` for (A); for (B) we require the co-PRESENCE of at least one
 * observing `pty_read` result and at least one driving `pty_write` in the trajectory (an
 * interactive session's write→read cycle), which is the conservative signal that a REPL / TUI /
 * server was actually driven and observed.
 */
export const inspectExerciseEvidence = (events: readonly AgentEvent[]): ExerciseVerdict => {
  // Index tool_result observation by call id so a container_exec run can be paired with its result.
  const resultObservedById = new Map<string, boolean>()
  let anyPtyWrite = false
  let ptyReadObserved = false

  for (const ev of events) {
    if (ev.type === "tool_result") {
      resultObservedById.set(ev.id, resultObservedOutput(ev))
      if (ev.name === PTY_READ && resultObservedOutput(ev)) ptyReadObserved = true
    }
  }

  for (const ev of events) {
    if (ev.type !== "tool_call") continue
    if (ev.name === PTY_WRITE) {
      anyPtyWrite = true
      continue
    }
    if (ev.name === CONTAINER_EXEC) {
      const command = containerExecCommand(ev)
      if (command === undefined) continue
      if (isNonExerciseCommand(command)) continue
      if (resultObservedById.get(ev.id) === true) {
        return {
          exercised: true,
          evidence: `container_exec ran the deliverable and observed its output: \`${command.trim().slice(0, 160)}\``,
        }
      }
    }
  }

  // (B) interactive exercise: drove the program (write) AND observed a response (read).
  if (anyPtyWrite && ptyReadObserved) {
    return {
      exercised: true,
      evidence:
        "pty_* session drove the interactive deliverable (pty_write) and observed its response (pty_read)",
    }
  }

  return {
    exercised: false,
    evidence:
      "no end-to-end exercise found: the trajectory only created/listed/read artifacts (or drove a program without observing its output) — the deliverable was never run and observed against the task's success criterion",
  }
}

/** The honest trichotomy the report stamps. `verified-pass` and `verified-fail` both mean the
 *  deliverable was EXERCISED and an outcome was observed; `unverifiable` means the gate could not
 *  confirm an exercise even after the one bounded follow-up (this is the accepted, non-penalized
 *  terminal state that STRUCTURALLY prevents over-persistence). */
export type VerificationState = "verified-pass" | "verified-fail" | "unverifiable"

/** The report's verification stamp. `evidence` names only the model's own trajectory / stated
 *  outcome — never a hidden test. */
export interface VerificationStamp {
  readonly state: VerificationState
  readonly evidence: string
}

/**
 * Outcome classification of the model's final SAY. ORDER MATTERS and is applied in
 * {@link deriveVerificationState} as: UNCERTAIN → NEGATIVE → (else) positive/silent. The design
 * priority is HONESTY over optimism — an explicit uncertainty or a stated failure is trusted over
 * a co-occurring positive word, because "fake green" is precisely the failure of trusting an
 * optimistic self-report. The only subtlety is SUCCESS-BY-NEGATION ("does not fail", "no errors",
 * "without error"), which superficially contains a negative word but ASSERTS success — those are
 * suppressed by {@link NEGATED_NEGATIVE} so they are NOT mis-read as `verified-fail`.
 */
const UNCERTAIN_OUTCOME =
  /\b(could ?n['o]?t verify|cannot verify|can['o]?t verify|unable to verify|unverifiable|not (?:sure|certain)|unclear|no way to (?:verify|check)|couldn['o]?t (?:confirm|check|run))\b/i
/** A failure the agent OBSERVED (not a hypothetical). */
const NEGATIVE_OUTCOME =
  /\b(fail(?:ed|s|ing|ure)?|did ?n['o]?t (?:pass|match|work)|does ?n['o]?t (?:pass|match|work)|mismatch(?:ed|es)?|do(?:es)? not match|incorrect|wrong output|error(?:ed|s)?)\b/i
/** Success expressed by NEGATING a negative — these must NOT trip {@link NEGATIVE_OUTCOME}. */
const NEGATED_NEGATIVE =
  /\b(no (?:errors?|failures?|mismatch(?:es)?|diff(?:erences?)?)|without (?:error|failure)|does ?n['o]?t fail|did ?n['o]?t fail|zero (?:errors?|failures?))\b/i

/**
 * Derive the honest verification state from the (post-follow-up) exercise verdict + the model's
 * final stated outcome. This is deliberately conservative and NEVER over-persists:
 *   - No exercise evidence at all ⇒ `unverifiable` (the gate asked once; nothing was exercised —
 *     finalize honestly rather than loop).
 *   - Exercised, and the final text asserts an uncertain/negative outcome ⇒ `unverifiable` /
 *     `verified-fail` respectively (honest surfacing of the real state, still finalizes).
 *   - Exercised, and the final text asserts a positive outcome (or is silent) ⇒ `verified-pass`.
 * The `finalText` is the model's OWN final SAY; the `evidence` we stamp comes from the exercise
 * verdict (its own tool calls) — no hidden-test reference ever enters.
 */
export const deriveVerificationState = (
  verdict: ExerciseVerdict,
  finalText: string,
): VerificationStamp => {
  const evidence = verdict.evidence ?? ""
  if (!verdict.exercised) {
    return {
      state: "unverifiable",
      evidence: `unverifiable — ${evidence}`,
    }
  }
  const text = finalText ?? ""
  // Uncertain claim wins first (the agent itself said it could not confirm).
  if (UNCERTAIN_OUTCOME.test(text)) {
    return { state: "unverifiable", evidence: `agent could not confirm the outcome; ${evidence}` }
  }
  // A stated failure is trusted (honesty over optimism), UNLESS it is success-by-negation
  // ("no errors" / "does not fail"), which asserts success and must not be read as a failure.
  if (NEGATIVE_OUTCOME.test(text) && !NEGATED_NEGATIVE.test(text)) {
    return { state: "verified-fail", evidence: `agent observed a failing outcome; ${evidence}` }
  }
  return { state: "verified-pass", evidence }
}
