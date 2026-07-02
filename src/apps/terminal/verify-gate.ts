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
 * (b) OBSERVES its output/behavior — as opposed to install/build/probe/scaffolding?
 *
 * WHY A NEW TERMINAL-SPECIFIC CLASSIFIER (not the existing `verify-guard`). The SWE-bench
 * `verify-guard` recognizes ONLY the `test_runner` tool or a `bash` command matching a test regex,
 * and its "mutating" notion is FS edit tools. The terminal brain surface has NONE of those tools —
 * only `container_exec` + `pty_*` (`src/apps/terminal/index.ts:37`). So the exercise contract MUST
 * be expressed over THIS surface's tools. `verify-guard` is a *philosophical* reference
 * (sticky-red "don't accept until verified"), NOT a code dependency.
 *
 * FAIL-CLOSED (review P0 — the prior version was BROKEN). The first version was fail-OPEN: any
 * `container_exec` whose leader was NOT in a small denylist counted as an exercise, and since
 * `container_exec` ALWAYS returns an exit code, "observed output" was trivially true. So
 * `pip install …`, `make`, `cargo build`, `python -c …`, and a bare PTY shell round-trip all
 * FALSELY satisfied the gate — defeating it on exactly the install-heavy tasks it exists for. This
 * version recognizes an exercise ONLY by an AFFIRMATIVE match:
 *   - `container_exec` (or a PTY-typed command) that RUNS the produced deliverable — a path
 *     invocation (`./mystery`, `/app/server`), an interpreter running a project FILE
 *     (`python solve.py`, NOT `python -c …`), a `bash script.sh`, or an acceptance/observe runner
 *     (`pytest`, `diff out ref`, `cmp`, `curl localhost/…`) — AND whose result carried observed
 *     output; OR
 *   - a `pty_*` session where a `pty_write` TYPED an exercise command (per the same classifier) AND
 *     a `pty_read` observed the response.
 * Everything else — package managers, build/compile tools, env probes, `ls`/`cat`/`grep`/`git`,
 * unknown bare words, interactive-shell chatter — is NON-exercise. A false "not exercised" costs
 * only ONE bounded follow-up turn (cheap + honest); a false "exercised" silently defeats the gate,
 * so we bias hard toward under-claiming.
 *
 * v2 — COMPARE-TO-REFERENCE (RFC jul-2 §03). L0 (ran+observed, {@link inspectExerciseEvidence})
 * is retained but is NO LONGER sufficient for `verified-pass`: v1's bug was rubber-stamping a mere
 * L0 run as green (the "ran it, declared green, never compared" cluster-A failure). v2 adds an L1
 * inspector ({@link comparedToReference}) — `verified-pass` now requires an OBSERVED comparison of
 * the deliverable's output against a DISTINCT, non-test reference. no-leak (R1): a comparison whose
 * reference is under a verifier/test path is REFUSED (a diff-against-the-hidden-golden must never
 * satisfy the gate). Behind `QUANTA_TB_VERIFY_GATE`; unset ⇒ NO gate (byte-identical).
 *
 * PURE / LEAF. No model calls, no IO, no `process.*`. Input is the captured `AgentEvent[]`;
 * output is a small typed verdict. Deterministic + unit-testable.
 */

import type { AgentEvent } from "@/stream"

const PTY_WRITE = "pty_write"
const PTY_READ = "pty_read"
const CONTAINER_EXEC = "container_exec"

/** Package managers, build/compile tools, and env probes. Running one proves *setup*, never
 *  *behavior against spec* — NEVER an exercise, even though it "runs something" and returns output. */
const BUILD_OR_INSTALL_TOOLS: ReadonlySet<string> = new Set([
  "pip", "pip3", "pip2", "pipx", "poetry", "uv", "conda", "mamba", "ensurepip", "easy_install",
  "npm", "pnpm", "yarn", "npx", "corepack",
  "cargo", "rustup", "go", "gem", "bundle", "composer", "mix", "sbt", "leiningen", "lein",
  "apt", "apt-get", "aptitude", "dpkg", "apk", "yum", "dnf", "pacman", "zypper", "brew", "port",
  "make", "cmake", "ninja", "meson", "bazel", "buck", "gradle", "gradlew", "mvn", "ant", "scons", "waf",
  "gcc", "g++", "cc", "c++", "clang", "clang++", "rustc", "tsc", "javac", "kotlinc", "ld", "ar", "as", "nvcc", "nasm",
  "configure", "autoconf", "automake", "autoreconf", "libtool", "pkg-config", "ldconfig",
  "docker", "docker-compose", "podman", "systemctl", "service", "modprobe", "update-alternatives",
])

/** Language interpreters that EXERCISE the deliverable when handed a FILE to run (not `-c`, not a
 *  package-manager `-m`). `python foo.py` exercises; `python -c "import x"` is a probe. */
const INTERPRETERS: ReadonlySet<string> = new Set([
  "python", "python3", "python2", "node", "nodejs", "ruby", "perl", "php", "lua",
  "rscript", "julia", "deno", "bun", "tclsh",
])

/** Runners that inherently RUN-AND-OBSERVE against the produced deliverable or a reference —
 *  `diff`/`cmp` compare to a reference, `curl`/`nc` hit a server, `pytest` runs behavior. */
const ACCEPTANCE_RUNNERS: ReadonlySet<string> = new Set([
  "pytest", "py.test", "tox", "nose", "nosetests",
  "diff", "cmp", "sdiff", "colordiff",
  "curl", "wget", "http", "nc", "ncat", "netcat", "ab", "wrk", "hey", "siege", "grpcurl",
])

/** POSIX shells — a `-c`/`-lc`/`-ic` wrapper is unwrapped and its inner command re-classified;
 *  a shell handed a `*.sh` script runs that script (exercise). A bare interactive shell is not. */
const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"])

/** Wrappers that prefix a command without changing what runs. */
const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  "sudo", "env", "nohup", "time", "stdbuf", "nice", "setsid", "timeout", "xargs", "unbuffer", "script",
])

/** basename of a leader token (strip any path), lower-cased. */
const baseName = (leader: string): string => {
  const slash = leader.lastIndexOf("/")
  return (slash >= 0 ? leader.slice(slash + 1) : leader).toLowerCase()
}

/** Tokenize a single command segment, skipping leading `VAR=val` assignments and transparent
 *  wrappers (`sudo`, `env`, `nohup`, `timeout N`, …). Returns the raw leader (may contain a path)
 *  + remaining arg tokens. `timeout`/`xargs` consume their own numeric/flag args crudely — we just
 *  skip a following bare-number/flag so `timeout 5 ./run` reduces to `./run`. */
const leaderAndArgs = (segment: string): { leader: string; args: readonly string[] } => {
  const tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0)
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (t === undefined) break
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || TRANSPARENT_WRAPPERS.has(t)) {
      i += 1
      // `timeout 5s`, `nice -n 10`, `stdbuf -oL` — skip a following number/flag arg.
      const nxt = tokens[i]
      if (nxt !== undefined && /^(-|\d)/.test(nxt)) i += 1
      continue
    }
    break
  }
  return { leader: tokens[i] ?? "", args: tokens.slice(i + 1) }
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

  // 3. acceptance / observe runners → exercise (run-and-observe against the deliverable/reference).
  if (ACCEPTANCE_RUNNERS.has(base)) return true

  // 4. interpreter → exercise ONLY when running a FILE (not `-c`, not a pkg-manager `-m`).
  if (INTERPRETERS.has(base)) {
    if (args.includes("-c")) return false // inline snippet / probe, not a run of a produced file
    const mIdx = args.findIndex((a) => a === "-m")
    if (mIdx >= 0) {
      const mod = (args[mIdx + 1] ?? "").toLowerCase()
      return !["pip", "pip3", "venv", "virtualenv", "ensurepip", "build", "installer", "wheel"].includes(mod)
    }
    return args.some((a) => !a.startsWith("-")) // a non-flag arg = a script/file to run
  }

  // 5. a path-invoked leader (`./x`, `/abs/x`, `../x`, `dir/x`) = running a produced artifact —
  //    UNLESS its basename is itself a build/install tool (`/usr/bin/make`).
  if (leader.includes("/")) return !BUILD_OR_INSTALL_TOOLS.has(base)

  // 6. anything else (bare unknown word, `ls`/`cat`/`grep`/`git`/`echo`, scaffolding) → FAIL CLOSED.
  return false
}

/** True iff ANY segment of a (possibly compound `a && b | c ; d`) command is an exercise. Catches
 *  `pip install x && ./run` (the run segment counts) without letting `mkdir x && ls` pass. */
export const isExerciseCommand = (command: string): boolean =>
  command
    .split(/(?:&&|\|\||[;|&\n])/)
    .some((seg) => seg.trim().length > 0 && isExerciseSegment(seg))

// ─────────────────────────────────────────────────────────────────────────────────────────────
// v2 — L1 "CHECKED" inspector: was the output COMPARED against a reference? (RFC jul-2 §03)
//
// L0 (ran+observed, above) is NECESSARY but NOT SUFFICIENT — v1's bug was stamping `verified-pass`
// on L0 alone (the "ran it, declared green, never compared" rubber-stamp). v2 requires an OBSERVED
// L1 comparison: a `diff`/`cmp`/… of TWO DISTINCT non-test artifacts, OR a script run referencing
// BOTH an output AND a reference operand, with the result observed. Fail-closed + no-leak (R1): a
// reference operand under a verifier/test path is NOT L1 (a diff-against-the-hidden-golden must
// never satisfy the gate — that would teach peeking).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The COMPARATOR leaders whose job IS to diff two artifacts. Two distinct non-test operands ⇒ L1. */
const COMPARATORS: ReadonlySet<string> = new Set(["diff", "cmp", "sdiff", "colordiff"])

/** R1 (CRITICAL, box-proven): a path under a verifier/test/answer corpus is NOT a fair reference —
 *  diffing against it is peeking at the hidden oracle. query-optimize's `golden.sql` lives in
 *  `/tests/`, so this exclusion is LOAD-BEARING, not a precaution. Matched on the operand path. */
const TEST_PATH_MARKERS: readonly RegExp[] = [
  /(^|\/)tests?(\/|$)/i, // /tests/, tests/, a `test`/`tests` dir segment
  /(^|\/)test_[^/]*/i, // test_*.py-style fixtures
  /(^|\/)[^/]*_test(\.[^/]*)?$/i, // *_test.py-style fixtures
  /verifier/i,
  /grader/i,
  /(^|\/)private(\/|$)/i,
  /answer/i,
  /solution/i,
  /golden/i,
  /expected_output/i,
]

/** True iff a path operand points into a verifier/test/answer corpus (R1 — never a fair reference). */
const isTestPath = (operand: string): boolean => TEST_PATH_MARKERS.some((re) => re.test(operand))

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
 *  `_ref`). This is the honest "this operand IS the reference" signal — a bare `out.json` in.json`
 *  run of the solver (no such signal) is NOT a comparison (fail-closed; costs one follow-up). */
const REFERENCE_HINT =
  /(--expected\b|--reference\b|--baseline\b|--golden\b|--oracle\b|--truth\b|--gold\b|--ref\b|expected[_-]?(output|value|result)|baseline|reference|original|golden|oracle|truth|[_-]ref\b|\bref[_./-])/i

/** Result of judging ONE command segment for an L1 comparison. `matchesTestPath` distinguishes the
 *  R1 fail-closed reject (a comparison AGAINST a test-path — recognized-but-refused) from "no
 *  comparison at all", so the caller can keep the honest "never compared" reason. */
interface SegmentL1 {
  readonly isCompare: boolean
  readonly refIsTestPath: boolean
}

/** Judge a SINGLE command segment for an L1 comparison (pure, fail-closed). */
const segmentComparesToReference = (segment: string): SegmentL1 => {
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
      return anySegmentComparesToReference(inner)
    }
    return { isCompare: false, refIsTestPath: false }
  }

  // (1) a COMPARATOR (`diff`/`cmp`/`sdiff`/`colordiff`) with TWO DISTINCT real operands.
  if (COMPARATORS.has(base)) {
    const operands = args.filter(isPathOperand)
    const distinct = [...new Set(operands)]
    if (distinct.length < 2) return { isCompare: false, refIsTestPath: false } // R4: `diff a a`, <2 operands
    // no-leak (R1): if ANY operand is under a verifier/test path, this is NOT a fair L1 comparison.
    if (distinct.some(isTestPath)) return { isCompare: false, refIsTestPath: true }
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
    // no-leak (R1): neither the SCRIPT ITSELF nor any operand may be under a verifier/test path —
    // RUNNING the hidden verifier/grader script (`python /app/tests/verify.py …`) is peeking too,
    // even when the compared operands look clean. Reject leader-in-test-path AND operand-in-test-path.
    if (isTestPath(leader) || operands.some(isTestPath)) return { isCompare: false, refIsTestPath: true }
    return { isCompare: true, refIsTestPath: false }
  }

  return { isCompare: false, refIsTestPath: false }
}

/** Judge a (possibly compound) command for an L1 comparison in ANY segment. */
const anySegmentComparesToReference = (command: string): SegmentL1 => {
  let refIsTestPath = false
  for (const seg of command.split(/(?:&&|\|\||[;|&\n])/)) {
    if (seg.trim().length === 0) continue
    const r = segmentComparesToReference(seg)
    if (r.isCompare) return { isCompare: true, refIsTestPath: false }
    if (r.refIsTestPath) refIsTestPath = true
  }
  return { isCompare: false, refIsTestPath }
}

/** The L1 verdict: did the trajectory OBSERVE a comparison of its output against a reference? */
export interface CompareVerdict {
  /** True iff an observed L1 comparison (per §03) was found — the sole path to `verified-pass`. */
  readonly compared: boolean
  /** True iff the ONLY comparison(s) found were AGAINST a verifier/test path (R1 fail-closed reject).
   *  Distinguishes "peeked at the hidden oracle" from "never compared" for honest evidence. */
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
 * count (R4); a comparison whose reference is under a verifier/test path is REFUSED (R1) — recognized
 * but rejected, and surfaced via `refusedTestPath` so the gate can never teach peeking.
 */
export const comparedToReference = (events: readonly AgentEvent[]): CompareVerdict => {
  const resultObservedById = new Map<string, boolean>()
  let ptyReadObserved = false
  for (const ev of events) {
    if (ev.type === "tool_result") {
      resultObservedById.set(ev.id, resultObservedOutput(ev))
      if (ev.name === PTY_READ && resultObservedOutput(ev)) ptyReadObserved = true
    }
  }

  let refusedTestPath = false
  for (const ev of events) {
    if (ev.type !== "tool_call") continue
    if (ev.name === CONTAINER_EXEC) {
      const command = containerExecCommand(ev)
      if (command === undefined) continue
      const r = anySegmentComparesToReference(command)
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
      const r = anySegmentComparesToReference(data)
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
      ? "no fair comparison found: the only comparison referenced a verifier/test path (refused — the gate never peeks at a hidden oracle)"
      : "no comparison found: the deliverable's output was never diffed/checked against a task-provided reference",
  }
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

/** Narrowed views over the two AgentEvent shapes we read. */
type ToolCallEvent = Extract<AgentEvent, { type: "tool_call" }>
type ToolResultEvent = Extract<AgentEvent, { type: "tool_result" }>

/** A tool result "observed output" when it carries a non-empty stdout preview OR a readable exit
 *  code. An `ok:false` result still counts as an observation — a failing run the agent SAW is
 *  honest evidence (it may finalize as `verified-fail`); what we reject is NO run at all. */
const resultObservedOutput = (r: ToolResultEvent): boolean =>
  (typeof r.preview === "string" && r.preview.trim().length > 0) || typeof r.exitCode === "number"

/** Extract the command string a `container_exec` tool_call carried (its input is `{ command }`). */
const containerExecCommand = (call: ToolCallEvent): string | undefined => {
  const input = call.input
  if (input !== null && typeof input === "object" && "command" in input) {
    const c = (input as { command?: unknown }).command
    if (typeof c === "string") return c
  }
  return undefined
}

/** Extract the bytes a `pty_write` tool_call TYPED (its input is `{ handle, data, appendNewline }`).
 *  This is the same field the dispatch seam screens as `shellCommand` — the payload that runs. */
const ptyWriteData = (call: ToolCallEvent): string | undefined => {
  const input = call.input
  if (input !== null && typeof input === "object" && "data" in input) {
    const d = (input as { data?: unknown }).data
    if (typeof d === "string") return d
  }
  return undefined
}

/** Extract the `command` a pane-starting `pty_*` call launched (e.g. `pty_start`/`pty_attach` with a
 *  `command`). When that command RUNS the deliverable (a produced binary / server / REPL of the
 *  produced program), driving+observing the pane is a real interactive exercise; when it is a bare
 *  `bash`/`python3` shell, it is not (the typed commands are then judged individually). */
const ptyPaneCommand = (call: ToolCallEvent): string | undefined => {
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
 *   (A) a `container_exec` ran an EXERCISE command (per {@link isExerciseCommand}) AND its paired
 *       `tool_result` observed output (stdout / exit code); OR
 *   (B) a `pty_write` TYPED an exercise command AND a `pty_read` observed a response.
 *
 * Fail-closed throughout: install/build/probe/scaffolding and bare-shell chatter never satisfy it.
 */
export const inspectExerciseEvidence = (events: readonly AgentEvent[]): ExerciseVerdict => {
  const resultObservedById = new Map<string, boolean>()
  let ptyReadObserved = false

  for (const ev of events) {
    if (ev.type === "tool_result") {
      resultObservedById.set(ev.id, resultObservedOutput(ev))
      if (ev.name === PTY_READ && resultObservedOutput(ev)) ptyReadObserved = true
    }
  }

  // PTY exercise needs THREE things: we drove the pane (a pty_write), we observed a response (a
  // pty_read with output), and what we drove is the DELIVERABLE — signalled by EITHER a pty_write
  // that TYPED an exercise command, OR a pane started running an exercise command (a REPL/server of
  // the produced program). A bare `bash`/`python3` pane driven with `ls`/`print(1)` yields neither
  // signal ⇒ fail-closed, not an exercise.
  let anyPtyWrite = false
  let ptyExerciseSignal: string | undefined
  for (const ev of events) {
    if (ev.type !== "tool_call") continue
    if (ev.name.startsWith("pty_")) {
      if (ev.name === PTY_WRITE) {
        anyPtyWrite = true
        const data = ptyWriteData(ev)
        if (data !== undefined && isExerciseCommand(data)) ptyExerciseSignal ??= `pty_write \`${data.trim().slice(0, 120)}\``
      } else {
        const paneCmd = ptyPaneCommand(ev)
        if (paneCmd !== undefined && isExerciseCommand(paneCmd))
          ptyExerciseSignal ??= `pane running \`${paneCmd.trim().slice(0, 120)}\``
      }
      continue
    }
    if (ev.name === CONTAINER_EXEC) {
      const command = containerExecCommand(ev)
      if (command === undefined) continue
      if (!isExerciseCommand(command)) continue
      if (resultObservedById.get(ev.id) === true) {
        return {
          exercised: true,
          evidence: `container_exec ran the deliverable and observed its output: \`${command.trim().slice(0, 160)}\``,
        }
      }
    }
  }

  // (B) interactive exercise: drove the DELIVERABLE (typed an exercise command OR a deliverable
  // pane) AND observed a response — never a bare-shell round-trip.
  if (anyPtyWrite && ptyExerciseSignal !== undefined && ptyReadObserved) {
    return {
      exercised: true,
      evidence: `pty_* session ran the deliverable (${ptyExerciseSignal}) and observed its response (pty_read)`,
    }
  }

  return {
    exercised: false,
    evidence:
      "no end-to-end exercise found: the trajectory only installed/built/inspected artifacts (or drove a shell without running the deliverable) — the deliverable was never run and observed against the task's success criterion",
  }
}

/** OC1 (RFC 07) — the OUTPUT-CONTRACT verdict: did the deliverable run END-TO-END to a CLEAN exit?
 *  Distinct from L0 exercise (which counts an `ok:false`/non-zero run as an honest observation) and
 *  from L1 compare (which can pass on a PARTIAL output match while the full deliverable is broken or
 *  leaves stray artifacts — the polyglot `cmain` / sam-cell-seg `exit 2` class). `ranClean` requires an
 *  exercise command whose paired result was `ok:true` with exit 0 (or no exit code surfaced). */
export interface OutputContractVerdict {
  readonly ranClean: boolean
  readonly evidence?: string
}

/** True iff a tool_result observed a SUCCESSFUL run: `ok:true` and (exit 0 | no exit code). A run the
 *  agent saw FAIL is honest L0 evidence but is NOT a clean contract satisfaction. */
const resultRanClean = (r: ToolResultEvent): boolean =>
  r.ok === true && (r.exitCode === undefined || r.exitCode === 0)

/**
 * OC1 inspector (RFC 07). Returns `ranClean:true` iff a `container_exec` ran an EXERCISE command
 * (per {@link isExerciseCommand}) whose paired `tool_result` was a CLEAN success ({@link resultRanClean}).
 * Fail-closed: a non-zero/`ok:false` run, a bare-shell round-trip, or install/build/probe never count —
 * so a deliverable that crashes at invocation (exit 2) or was never run to completion yields `false`,
 * which the gate turns into the OC1 follow-up. No-leak: reads only the model's own commands/results.
 */
export const outputContractVerdict = (events: readonly AgentEvent[]): OutputContractVerdict => {
  const cleanById = new Map<string, boolean>()
  for (const ev of events) {
    if (ev.type === "tool_result") cleanById.set(ev.id, resultRanClean(ev))
  }
  for (const ev of events) {
    if (ev.type !== "tool_call" || ev.name !== CONTAINER_EXEC) continue
    const command = containerExecCommand(ev)
    if (command === undefined || !isExerciseCommand(command)) continue
    if (cleanById.get(ev.id) === true) {
      return {
        ranClean: true,
        evidence: `ran the deliverable end-to-end to a clean exit: \`${command.trim().slice(0, 160)}\``,
      }
    }
  }
  return {
    ranClean: false,
    evidence:
      "output contract unmet: the deliverable was never run end-to-end to a CLEAN exit (it crashed on invocation, exited non-zero, or was never run as the task specifies) — required outputs / a stray-artifact-free workdir are unconfirmed",
  }
}

/** The honest trichotomy the report stamps (v2 semantics). `verified-pass` / `verified-fail` both
 *  mean an OBSERVED L1 comparison happened (output diffed/checked against a non-test reference) and
 *  the result was match / mismatch respectively; `unverifiable` means no fair L1 comparison was
 *  found even after the one bounded follow-up — the accepted, non-penalized terminal state that
 *  STRUCTURALLY prevents over-persistence, and the state that (post-v2) a mere ran-but-unchecked
 *  run resolves to (never a false `verified-pass`). */
export type VerificationState = "verified-pass" | "verified-fail" | "unverifiable"

/** The report's verification stamp. `evidence` names only the model's own trajectory / stated
 *  outcome — never a hidden test. */
export interface VerificationStamp {
  readonly state: VerificationState
  readonly evidence: string
  /** Whether the one bounded follow-up turn was actually injected (vs an exercise already present
   *  in the main run). Lets per-task A/B analysis attribute a flip to the gate's nudge rather than
   *  the base loop. Absent on the OFF path (the whole stamp is absent then). */
  readonly followUpFired?: boolean
}

/**
 * Outcome classification of the model's final SAY. ORDER MATTERS: UNCERTAIN → NEGATIVE → (else)
 * positive/silent. HONESTY over optimism — an explicit uncertainty or stated failure is trusted
 * over a co-occurring positive word, because "fake green" is precisely the failure of trusting an
 * optimistic self-report. SUCCESS-BY-NEGATION ("does not fail", "no errors") is suppressed by
 * {@link NEGATED_NEGATIVE} so it is NOT mis-read as `verified-fail`.
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
 * v2 GATE POLICY (RFC jul-2 §03) — derive the honest verification state from the (post-follow-up)
 * L1 COMPARE verdict + the model's final stated outcome. `verified-pass` is UNREACHABLE without an
 * OBSERVED L1 comparison — this closes v1's rubber-stamp (which stamped `verified-pass` on a mere
 * L0 run). NEVER over-persists (the caller fires at most one follow-up; this is a pure classifier):
 *   - L1 present + agent reports mismatch/uncertain ⇒ `verified-fail` / `unverifiable` (honest).
 *   - L1 present + agent reports match / silent     ⇒ `verified-pass` (the ONLY path to pass).
 *   - No L1 (ran but never compared, or nothing ran) ⇒ `unverifiable` (honest — never a false pass).
 *
 * The exercise (L0) verdict is retained ONLY to color the evidence line (ran-but-unchecked vs
 * nothing-ran); it can NO LONGER by itself yield `verified-pass`.
 */
export const deriveVerificationState = (
  compareVerdict: CompareVerdict,
  finalText: string,
  exerciseVerdict?: ExerciseVerdict,
): VerificationStamp => {
  const evidence = compareVerdict.evidence ?? ""
  // No observed L1 comparison ⇒ unverifiable, whatever the model SAYS (the rubber-stamp is dead).
  if (!compareVerdict.compared) {
    const ran = exerciseVerdict?.exercised === true
    const reason = ran
      ? `ran the deliverable but never compared its output to a reference — ${evidence}`
      : evidence
    return { state: "unverifiable", evidence: `unverifiable — ${reason}` }
  }
  const text = finalText ?? ""
  if (UNCERTAIN_OUTCOME.test(text)) {
    return { state: "unverifiable", evidence: `compared, but the agent could not confirm the outcome; ${evidence}` }
  }
  if (NEGATIVE_OUTCOME.test(text) && !NEGATED_NEGATIVE.test(text)) {
    return { state: "verified-fail", evidence: `compared and observed a mismatch; ${evidence}` }
  }
  return { state: "verified-pass", evidence }
}
