/**
 * `@/apps/terminal/verify-gate/self-test` — S1b SELF-TEST RECEIPT: OBSERVE-ONLY measurement of the
 * self-test discipline (`QUANTA_TB_SELF_TEST`). Did the agent build + RUN its own spec-derived
 * self-test, and did it go green?
 *
 * OBSERVE-ONLY by design (RFC jul-3 hell-audit R2): coverage (case count / edge presence) is NOT
 * deterministically recoverable from a cassette, so `green` means only "a self-test-shaped command
 * the agent AUTHORED exited 0" — nothing stronger. The receipt therefore NEVER gates submission on
 * its own; a consumer that gates on it (best-of-n P2) must corroborate with an independent signal.
 *
 * NO-LEAK: the peek guard REUSES the oracle-taint SSOT ({@link isUnfair} / {@link buildTaintedRefs})
 * — the SAME predicate the compare layer refuses with — so a laundered-oracle self-test
 * (`cp /tests/g ref && python test_it.py`) is refused byte-identically (jul-3 hell-audit F2). PURE.
 */

import type { AgentEvent } from "@/stream"
import { resultObservedOutput, resultRanClean } from "./exercise"
import { buildTaintedRefs, isOracleLocation, isUnfairLocation } from "./oracle-taint"
import {
  baseName,
  COMPOUND_SEP,
  CONTAINER_EXEC,
  containerExecCommand,
  INTERPRETERS,
  leaderAndArgs,
  normalizeToken,
  PTY_WRITE,
  ptyWriteData,
  SHELLS,
  TEST_RUNNERS,
} from "./tokenize"

/** An agent-AUTHORED test artifact (its own self-test file), by conventional name. NAMING only — the
 *  oracle LOCATION guard is the taint predicate below (a `test_x.py` the agent wrote is creditable;
 *  a `/tests/test_x.py` under the hidden corpus is not). */
const SELF_TEST_FILE_MARKERS: readonly RegExp[] = [
  /(^|\/)test_[^/]*\.[a-z0-9_]+$/i, // test_fib.py
  /(^|\/)[a-z0-9_]*_test\.[a-z0-9_]+$/i, // fib_test.go
  /(^|\/)tests?\.[a-z0-9_]+$/i, // test.py / tests.py
  /(^|\/)(self[_-]?test|run[_-]?tests?)[^/]*$/i, // selftest.sh / run_tests.sh
]

const isSelfTestFile = (tok: string): boolean => SELF_TEST_FILE_MARKERS.some((re) => re.test(tok))

/** F3 (jul-3 hell-audit): a test-runner operand that names a concrete FILE the agent could have
 *  authored — an agent self-test name, OR any token with a file extension (`my_check.py`) — but NOT
 *  a directory / `.` / bare word (`pytest .` / `pytest src` would DISCOVER the hidden suite). */
const looksLikeTestFileOperand = (tok: string): boolean => {
  const n = normalizeToken(tok)
  if (n === "" || n === "." || n === ".." || n.endsWith("/")) return false
  return isSelfTestFile(n) || /\.[a-z0-9]+$/i.test(n)
}

/** True iff a SINGLE command segment RUNS an agent-authored self-test. `unfair` refuses any operand
 *  that is / derives from the hidden oracle (shared taint predicate). Fail-closed: anything not
 *  affirmatively a self-test the agent wrote returns false.
 *
 *  F3 (jul-3 hell-audit): a test-runner is credited ONLY when it NAMES an agent-authored self-test
 *  FILE (`pytest my_check.py`), never a bare-suite / directory / `.` operand (`pytest .` discovers
 *  the hidden suite). */
const isSelfTestSegment = (segment: string, unfair: (tok: string) => boolean): boolean => {
  const { leader, args } = leaderAndArgs(segment)
  if (leader === "") return false
  const base = baseName(leader)

  // shell wrapper: `bash -c '<inner>'` → judge the INNER command; `bash selftest.sh` → the script.
  if (SHELLS.has(base)) {
    const cIdx = args.findIndex((a) => a === "-c" || a === "-lc" || a === "-ic" || a === "-ilc")
    if (cIdx >= 0) {
      const inner = args
        .slice(cIdx + 1)
        .join(" ")
        .replace(/^['"]|['"]$/g, "")
      return isSelfTestSegmentsOf(inner, unfair)
    }
    return args.some((a) => !a.startsWith("-") && isSelfTestFile(a) && !unfair(a))
  }

  // signal 2 — ran an agent-authored test-named file (interpreter FILE, or path-invoked script).
  if (args.some((a) => isSelfTestFile(normalizeToken(a)) && !unfair(a))) return true
  if (leader.includes("/") && isSelfTestFile(normalizeToken(leader)) && !unfair(leader)) return true

  // signal 3 — a real test-runner (pytest/tox/nose, incl. `python -m pytest`) that NAMES a concrete
  //   non-oracle FILE operand (F3: a bare runner / `.` / directory could DISCOVER the hidden suite
  //   and is NOT credited; only an explicit file the agent points it at counts).
  const runsTestRunner =
    TEST_RUNNERS.has(base) ||
    (INTERPRETERS.has(base) &&
      (() => {
        const mIdx = args.indexOf("-m")
        return mIdx >= 0 && TEST_RUNNERS.has((args[mIdx + 1] ?? "").toLowerCase())
      })())
  if (
    runsTestRunner &&
    args.some(
      (a) =>
        !a.startsWith("-") &&
        !TEST_RUNNERS.has(a.toLowerCase()) &&
        looksLikeTestFileOperand(a) &&
        !unfair(a),
    )
  )
    return true

  return false
}

/** Interpreters whose `-c`/`-e` flag runs an INLINE program (where an `assert` = a self-test). */
const INLINE_ASSERT_LEADER = /\b(python3?|node|nodejs|ruby|perl|deno|bun)\b[^\n]*\s-[ce]\b/i

/** Segment-fanout helper (used by the shell-wrapper recursion). */
const isSelfTestSegmentsOf = (command: string, unfair: (tok: string) => boolean): boolean =>
  command.split(COMPOUND_SEP).some((seg) => seg.trim().length > 0 && isSelfTestSegment(seg, unfair))

/** True iff a (possibly compound) command runs an agent-AUTHORED self-test — and touches NO hidden
 *  oracle (directly or laundered) anywhere. Two credited shapes: (1) an inline `-c`/`-e` assertion
 *  (judged on the WHOLE string since the snippet may itself contain `;`), or (2) a segment that runs
 *  a test-named file / a test-runner over an agent-authored self-test file. `tainted` carries the
 *  laundering set from the whole trajectory (F2). Fail-closed + global peek guard. */
export const isSelfTestCommand = (
  command: string,
  tainted: ReadonlySet<string> = new Set(),
): boolean => {
  const unfair = (tok: string): boolean => isUnfairLocation(tok, tainted)
  // Global peek guard: refuse if ANY token is / derives from the hidden oracle (peeking wins).
  if (command.split(/\s+/).some((tok) => tok.length > 0 && unfair(tok))) return false
  if (INLINE_ASSERT_LEADER.test(command) && /\bassert\b/i.test(command)) return true
  return isSelfTestSegmentsOf(command, unfair)
}

/** OBSERVE-ONLY self-test receipt (S1b). NEVER gates alone; measurement only. `executed` = the agent
 *  ran a self-test it authored (observed output); `green` = the LAST such observed run was a clean
 *  success (exit 0, not timed out — "iterate to green" makes the FINAL run the one that counts).
 *  `flippedFromRed` (F4) = an EARLIER agent-authored self-test was observed RED before the final
 *  green one — a signal that a green may have been reached by switching to a weaker test, which a
 *  gating consumer treats with suspicion. */
export interface SelfTestReceipt {
  readonly executed: boolean
  readonly green: boolean
  readonly flippedFromRed?: boolean
  /** Names only the model's OWN self-test command — never a hidden test. */
  readonly evidence?: string
}

/** Collect ALL of the model's own executed/typed command strings (container_exec + pty_write) — the
 *  SOURCE the laundering-taint pass walks. SHARED by {@link inspectSelfTest} and
 *  {@link lastSelfTestFailure} so both build the IDENTICAL taint set (the F2 byte-identical-predicate
 *  promise — a drift here would let one function credit a laundered self-test the other refuses). */
const collectOwnCommands = (events: readonly AgentEvent[]): string[] => {
  const out: string[] = []
  for (const ev of events) {
    if (ev.type !== "tool_call") continue
    if (ev.name === CONTAINER_EXEC) {
      const c = containerExecCommand(ev)
      if (c !== undefined) out.push(c)
    } else if (ev.name === PTY_WRITE) {
      const d = ptyWriteData(ev)
      if (d !== undefined) out.push(d)
    }
  }
  return out
}

/** Inspect the stream for an agent-authored self-test run (S1b). Container-exec only for now (self-
 *  tests are non-interactive); a pty-driven self-test is out of scope and simply not credited. */
export const inspectSelfTest = (events: readonly AgentEvent[]): SelfTestReceipt => {
  const observedById = new Map<string, boolean>()
  const cleanById = new Map<string, boolean>()
  for (const ev of events) {
    if (ev.type === "tool_result") {
      observedById.set(ev.id, resultObservedOutput(ev))
      cleanById.set(ev.id, resultRanClean(ev))
    }
  }
  // F2: laundering taint from the same SSOT — but keyed on the oracle LOCATION as the source (an
  // agent's own `cp test_fib.py ref` must not taint `ref`; only a real oracle read does).
  const tainted = buildTaintedRefs(collectOwnCommands(events), isOracleLocation)

  let executed = false
  let green = false
  let sawRed = false
  let evidence: string | undefined
  // Chronological: the LAST observed self-test decides `green` (iterate-to-green ⇒ final run counts).
  for (const ev of events) {
    if (ev.type !== "tool_call" || ev.name !== CONTAINER_EXEC) continue
    const command = containerExecCommand(ev)
    if (command === undefined || !isSelfTestCommand(command, tainted)) continue
    if (observedById.get(ev.id) !== true) continue
    executed = true
    green = cleanById.get(ev.id) === true
    if (!green) sawRed = true
    evidence = `ran a self-test the agent authored${green ? " (passed)" : " (did not pass)"}: \`${command.trim().slice(0, 160)}\``
  }
  // F4: green reached only AFTER an earlier red self-test — surface it so a gating consumer can
  // distinguish honest iterate-to-green from a switch to a weaker test.
  const flippedFromRed = green && sawRed
  return {
    executed,
    green,
    ...(flippedFromRed ? { flippedFromRed: true } : {}),
    ...(evidence !== undefined
      ? { evidence }
      : {
          evidence:
            "no agent-authored self-test observed: the trajectory ran no test-named file / inline assertion / non-oracle test-runner against the deliverable",
        }),
  }
}

/** The command + observed output of the LAST agent-authored self-test that ran RED (observed, not
 *  clean). Used by the oracle-repair loop (Phase C) to feed a failing self-test's OWN output back to
 *  the model. NO-LEAK by construction: it reads ONLY a command that {@link isSelfTestCommand} credits
 *  as the agent's own self-test (the shared taint/oracle predicate rejects any run that touches or is
 *  derived from the hidden oracle), and returns that command's OWN result preview — never a hidden
 *  verifier's output. Undefined when no red agent-authored self-test was observed. */
export const lastSelfTestFailure = (
  events: readonly AgentEvent[],
): { command: string; output: string } | undefined => {
  const previewById = new Map<string, string>()
  const cleanById = new Map<string, boolean>()
  const observedById = new Map<string, boolean>()
  for (const ev of events) {
    if (ev.type !== "tool_result") continue
    previewById.set(ev.id, typeof ev.preview === "string" ? ev.preview : "")
    cleanById.set(ev.id, resultRanClean(ev))
    observedById.set(ev.id, resultObservedOutput(ev))
  }
  // F2: SAME taint source as inspectSelfTest (collectOwnCommands: container_exec + pty_write) so both
  // refuse a laundered self-test byte-identically — no drift (jul-3 final-audit finding #2).
  const tainted = buildTaintedRefs(collectOwnCommands(events), isOracleLocation)
  let last: { command: string; output: string } | undefined
  for (const ev of events) {
    if (ev.type !== "tool_call" || ev.name !== CONTAINER_EXEC) continue
    const command = containerExecCommand(ev)
    if (command === undefined || !isSelfTestCommand(command, tainted)) continue
    if (observedById.get(ev.id) !== true || cleanById.get(ev.id) === true) continue // observed RED only
    last = { command, output: (previewById.get(ev.id) ?? "").slice(0, 4000) }
  }
  return last
}
