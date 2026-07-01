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

/** The honest trichotomy the report stamps. `verified-pass` and `verified-fail` both mean the
 *  deliverable was EXERCISED and an outcome was observed; `unverifiable` means the gate could not
 *  confirm an exercise even after the one bounded follow-up (the accepted, non-penalized terminal
 *  state that STRUCTURALLY prevents over-persistence). */
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
 * Derive the honest verification state from the (post-follow-up) exercise verdict + the model's
 * final stated outcome. Conservative and NEVER over-persists:
 *   - No exercise evidence ⇒ `unverifiable` (asked once; nothing exercised — finalize honestly).
 *   - Exercised + uncertain/negative final ⇒ `unverifiable` / `verified-fail` (honest surfacing).
 *   - Exercised + positive/silent final ⇒ `verified-pass`.
 */
export const deriveVerificationState = (
  verdict: ExerciseVerdict,
  finalText: string,
): VerificationStamp => {
  const evidence = verdict.evidence ?? ""
  if (!verdict.exercised) {
    return { state: "unverifiable", evidence: `unverifiable — ${evidence}` }
  }
  const text = finalText ?? ""
  if (UNCERTAIN_OUTCOME.test(text)) {
    return { state: "unverifiable", evidence: `agent could not confirm the outcome; ${evidence}` }
  }
  if (NEGATIVE_OUTCOME.test(text) && !NEGATED_NEGATIVE.test(text)) {
    return { state: "verified-fail", evidence: `agent observed a failing outcome; ${evidence}` }
  }
  return { state: "verified-pass", evidence }
}
