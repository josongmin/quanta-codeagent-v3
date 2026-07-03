/**
 * Unit hellgate for the terminal verify-before-finalize EVIDENCE INSPECTOR (Lever #2).
 *
 * The inspector is a PURE function over the recorded `AgentEvent[]` — this suite pins its exercise
 * contract for BOTH terminal tools (`container_exec` + `pty_*`, review P1), the conservative
 * scaffolding/inspection exclusions, and the honest verified-pass/verified-fail/unverifiable
 * trichotomy. No loop / no IO is exercised here; the gate wiring + ≤1-turn cap live in
 * `brain-mode.test.ts`.
 */
import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@/stream"
import {
  buildTaintedRefs,
  comparedToReference,
  deriveVerificationState,
  inspectExerciseEvidence,
  inspectSelfTest,
  isExerciseCommand,
  isSelfTestCommand,
  outputContractVerdict,
  type VerificationState,
} from "./verify-gate"

/** Build a `tool_call` AgentEvent. */
const call = (id: string, name: string, input: unknown): AgentEvent => ({
  type: "tool_call",
  id,
  name,
  input,
})
/** Build a `tool_result` AgentEvent. `preview` defaults empty; pass `exitCode`/`preview` to shape
 *  observation. */
const result = (
  id: string,
  name: string,
  extra: { preview?: string; exitCode?: number; ok?: boolean; timedOut?: boolean } = {},
): AgentEvent => ({
  type: "tool_result",
  id,
  name,
  ok: extra.ok ?? true,
  preview: extra.preview ?? "",
  ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
  ...(extra.timedOut !== undefined ? { timedOut: extra.timedOut } : {}),
})

describe("outputContractVerdict (OC1, RFC 07) — clean end-to-end run", () => {
  test("ranClean=true on an exercise command with ok+exit 0", () => {
    const v = outputContractVerdict([
      call("c1", "container_exec", { command: "./build/mystery input.txt" }),
      result("c1", "container_exec", { preview: "42 43 44\n", exitCode: 0 }),
    ])
    expect(v.ranClean).toBe(true)
    expect(v.evidence).toContain("clean exit")
  })

  test("red-on-injection: a deliverable that CRASHES at invocation (exit 2) is NOT clean", () => {
    // sam-cell-seg class: the script runs but exits non-zero → contract unmet, nudge must fire.
    const v = outputContractVerdict([
      call("c1", "container_exec", { command: "python /app/convert_masks.py --out x.csv" }),
      result("c1", "container_exec", { preview: "Traceback", exitCode: 2, ok: false }),
    ])
    expect(v.ranClean).toBe(false)
    expect(v.evidence).toContain("output contract unmet")
  })

  test("ok:false with no exit code is NOT clean (failure the agent saw)", () => {
    const v = outputContractVerdict([
      call("c1", "container_exec", { command: "/app/mystery" }),
      result("c1", "container_exec", { preview: "boom", ok: false }),
    ])
    expect(v.ranClean).toBe(false)
  })

  // P1-A (RFC jul-3) — the REAL crash shape: container_exec returns ok:TRUE with a non-zero exit
  // (its contract). The prior ok:false fixture let a mutation dropping the `exitCode===0` check
  // survive. This pins that a {ok:true, exitCode:2} crash is NOT clean.
  test("REAL-SHAPE crash {ok:true, exitCode:2} on container_exec is NOT clean", () => {
    const v = outputContractVerdict([
      call("c1", "container_exec", { command: "python /app/convert.py" }),
      result("c1", "container_exec", { preview: "Traceback", exitCode: 2, ok: true }),
    ])
    expect(v.ranClean).toBe(false)
  })

  // P1-A fail-closed: container_exec ALWAYS surfaces a code, so a missing exitCode = broken wire ⇒
  // NOT clean (else a silently-broken exitCode wire rubber-stamps every crash).
  test("container_exec with MISSING exitCode (broken wire) is NOT clean", () => {
    const v = outputContractVerdict([
      call("c1", "container_exec", { command: "./run" }),
      result("c1", "container_exec", { preview: "done", ok: true }), // no exitCode
    ])
    expect(v.ranClean).toBe(false)
  })

  test("install/build only (no exercise run) ⇒ not clean (fail-closed)", () => {
    const v = outputContractVerdict([
      call("c1", "container_exec", { command: "pip install numpy" }),
      result("c1", "container_exec", { preview: "Successfully installed", exitCode: 0 }),
    ])
    expect(v.ranClean).toBe(false)
  })

  test("no events ⇒ not clean", () => {
    expect(outputContractVerdict([]).ranClean).toBe(false)
  })
})

describe("inspectExerciseEvidence — container_exec", () => {
  test("running a produced binary AND observing stdout ⇒ exercised", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "./build/mystery input.txt" }),
      result("c1", "container_exec", { preview: "42 43 44\n", exitCode: 0 }),
    ]
    const v = inspectExerciseEvidence(events)
    expect(v.exercised).toBe(true)
    expect(v.evidence).toContain("container_exec")
  })

  test("running a produced binary whose result has ONLY an exit code (no stdout) ⇒ exercised", () => {
    // Reading the exit code IS an observation (exit 0 = the completion signal per the op guide).
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "/app/mystery" }),
      result("c1", "container_exec", { preview: "", exitCode: 1, ok: true }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(true)
  })

  test("a diff against a reference binary's output ⇒ exercised", () => {
    // The canonical path-tracing-reverse fix: run + diff against reference. `diff` is NOT a
    // scaffolding leader, and it observes output.
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "diff image.ppm /app/reference.ppm" }),
      result("c1", "container_exec", { preview: "", exitCode: 0 }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(true)
  })

  test.each([
    ["mkdir -p out", "mkdir"],
    ["ls -la /app", "ls"],
    ["cat solution.py", "cat"],
    ["echo done > flag", "echo"],
    ["touch artifact", "touch"],
    ["cp a b", "cp"],
    ["command -v python", "command -v probe"],
    ["find / -name mystery", "find"],
    ["git status", "git (noise-verify escape)"],
    ["grep -r TODO src", "grep"],
  ])("scaffolding/inspection %p (%s) alone ⇒ NOT exercised", (command) => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command }),
      result("c1", "container_exec", { preview: "some text", exitCode: 0 }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(false)
  })

  test("running the binary but the result was NEVER observed (no preview, no exitCode) ⇒ NOT exercised", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "./mystery" }),
      result("c1", "container_exec", { preview: "" }), // no exitCode, empty preview
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(false)
  })

  test("a leading env-assignment + sudo wrapper does not hide the scaffolding leader", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "FOO=1 sudo mkdir /x" }),
      result("c1", "container_exec", { preview: "ok", exitCode: 0 }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(false)
  })

  test("a leading env-assignment before a real RUN still counts as exercise", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "LD_LIBRARY_PATH=/lib ./solver in.txt" }),
      result("c1", "container_exec", { preview: "solved", exitCode: 0 }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(true)
  })

  test("malformed / non-string command input does not crash and is ignored", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: 42 }),
      call("c2", "container_exec", {}),
      call("c3", "container_exec", null),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(false)
  })

  test("a failing (ok:false) run that WAS observed still counts as exercised (honest fail evidence)", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "python solver.py" }),
      result("c1", "container_exec", { preview: "Traceback...", exitCode: 1, ok: false }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(true)
  })
})

describe("inspectExerciseEvidence — pty_* (review P1: interactive deliverable must count; P0: shell chatter must NOT)", () => {
  test("a pane RUNNING THE DELIVERABLE, driven + observed ⇒ exercised", () => {
    const events: AgentEvent[] = [
      call("p0", "pty_start", { command: "python3 game.py" }), // pane runs the produced program
      call("p1", "pty_write", { handle: "h", data: "north", appendNewline: true }),
      result("p1", "pty_write", { preview: "ok" }),
      call("p2", "pty_read", { handle: "h" }),
      result("p2", "pty_read", { preview: "You move north.\n[nextSeq=3]" }),
    ]
    const v = inspectExerciseEvidence(events)
    expect(v.exercised).toBe(true)
    expect(v.evidence).toContain("pty_")
  })

  test("typing an EXERCISE command into a bash pane (`./mystery`) + observing ⇒ exercised", () => {
    const events: AgentEvent[] = [
      call("p0", "pty_start", { command: "bash" }),
      call("p1", "pty_write", { handle: "h", data: "./mystery in.txt", appendNewline: true }),
      result("p1", "pty_write", { preview: "ok" }),
      call("p2", "pty_read", { handle: "h" }),
      result("p2", "pty_read", { preview: "42\n[nextSeq=3]" }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(true)
  })

  test("P0 fail-closed: a bare bash pane driven with SHELL CHATTER (`ls`/`cd`) + read ⇒ NOT exercised", () => {
    const events: AgentEvent[] = [
      call("p0", "pty_start", { command: "bash" }),
      call("p1", "pty_write", { handle: "h", data: "ls -la", appendNewline: true }),
      result("p1", "pty_write", { preview: "ok" }),
      call("p2", "pty_read", { handle: "h" }),
      result("p2", "pty_read", { preview: "solution.py  Makefile\n[nextSeq=3]" }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(false)
  })

  test("P0 fail-closed: a bare `python3` REPL driven with a probe expression ⇒ NOT exercised", () => {
    // Attaching a generic interpreter and typing `print(2+2)` is NOT a clear deliverable exercise.
    const events: AgentEvent[] = [
      call("p0", "pty_start", { command: "python3" }),
      call("p1", "pty_write", { handle: "h", data: "print(2+2)", appendNewline: true }),
      result("p1", "pty_write", { preview: "ok" }),
      call("p2", "pty_read", { handle: "h" }),
      result("p2", "pty_read", { preview: "4\n[nextSeq=3]" }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(false)
  })

  test("attaching a pane WITHOUT driving it (no pty_write) ⇒ NOT exercised", () => {
    const events: AgentEvent[] = [
      call("p0", "pty_start", { command: "./server" }),
      call("p2", "pty_read", { handle: "h" }),
      result("p2", "pty_read", { preview: "listening\n" }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(false)
  })

  test("driving the deliverable without ever reading back the response ⇒ NOT exercised", () => {
    const events: AgentEvent[] = [
      call("p1", "pty_write", { handle: "h", data: "./run", appendNewline: true }),
      result("p1", "pty_write", { preview: "ok" }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(false)
  })

  test("a pty_read that observed NOTHING (empty preview, no exitCode) ⇒ NOT exercised", () => {
    const events: AgentEvent[] = [
      call("p1", "pty_write", { handle: "h", data: "./run", appendNewline: true }),
      result("p1", "pty_write", { preview: "ok" }),
      call("p2", "pty_read", { handle: "h" }),
      result("p2", "pty_read", { preview: "" }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(false)
  })
})

describe("isExerciseCommand — fail-closed (review P0: install/build/probe/chatter must NOT satisfy the gate)", () => {
  test.each([
    "pip install grpcio",
    "pip3 install -r requirements.txt",
    "python -m pip install numpy",
    "npm install",
    "npm ci",
    "yarn add express",
    "cargo build --release",
    "make",
    "make -j4 all",
    "cmake --build build",
    "gcc -o mystery mystery.c",
    "g++ solve.cpp -o solve",
    "go build ./...",
    'python -c "import grpc; print(grpc.__version__)"',
    "python3 -c 'print(1)'",
    "bash -lc 'echo ok'",
    "sh -c 'echo hi'",
    "apt-get install -y qemu",
    "./configure --prefix=/usr",
    "conda install pytorch",
    "ls -la",
    "cat solution.py",
    "git status",
    "grep -r TODO .",
    "echo done",
    "which python3",
  ])("NON-exercise: %p ⇒ false", (cmd) => {
    expect(isExerciseCommand(cmd)).toBe(false)
  })

  test.each([
    "./mystery input.txt",
    "/app/server --port 8080",
    "../bin/solve",
    "python solve.py",
    "python3 game.py --seed 1",
    "node app.js",
    "bash run_tests.sh",
    "diff out.ppm /app/reference.ppm",
    "cmp a.bin b.bin",
    "curl -s localhost:8080/health",
    "python -m http.server 8000",
    "LD_LIBRARY_PATH=/lib ./solver in.txt",
    "timeout 5 ./run",
    "pip install x && ./mystery run", // compound: the run segment counts
    "bash -c './mystery > out.txt'", // shell wrapper unwraps to a real run
  ])("EXERCISE: %p ⇒ true", (cmd) => {
    expect(isExerciseCommand(cmd)).toBe(true)
  })

  // P2-B (RFC jul-3): test-RUNNERS run the suite / hidden oracle — NOT an exercise of the
  // deliverable (peeking + best-of-N tie-break inflation). Observe-runners stay TRUE.
  test.each([
    "pytest tests/",
    "pytest",
    "python -m pytest",
    "tox",
    "nose2",
    "nosetests",
  ])("TEST-RUNNER: %p ⇒ NOT exercise", (cmd) => {
    expect(isExerciseCommand(cmd)).toBe(false)
  })
  test.each([
    "python -m http.server 8000",
    "curl -s localhost:8080/health",
  ])("OBSERVE-RUNNER: %p ⇒ still exercise", (cmd) => {
    expect(isExerciseCommand(cmd)).toBe(true)
  })
})

describe("comparedToReference — P2-A marker split (task-provided reference vs hidden oracle)", () => {
  test("diff against a cwd `expected_output.csv` (task-provided pair) ⇒ compared (no longer refused)", () => {
    const v = comparedToReference([
      call("c1", "container_exec", { command: "diff mine.csv expected_output.csv" }),
      result("c1", "container_exec", { preview: "", exitCode: 0 }),
    ])
    expect(v.compared).toBe(true)
    expect(v.refusedTestPath).toBe(false)
  })
  test("diff against a /tests/ path (hidden oracle) ⇒ still refused (no-leak preserved)", () => {
    const v = comparedToReference([
      call("c1", "container_exec", { command: "diff out.csv /app/tests/golden.csv" }),
      result("c1", "container_exec", { preview: "", exitCode: 0 }),
    ])
    expect(v.compared).toBe(false)
    expect(v.refusedTestPath).toBe(true)
  })
})

describe("inspectExerciseEvidence — empty / no-tool trajectories", () => {
  test("no tool calls at all ⇒ NOT exercised with an honest reason", () => {
    const v = inspectExerciseEvidence([
      { type: "assistant_text", delta: "all done, verified green" },
    ])
    expect(v.exercised).toBe(false)
    expect(v.evidence).toContain("no end-to-end exercise")
  })
})

describe("deriveVerificationState — v2 honest trichotomy (L1-gated; verified-pass requires a compare)", () => {
  const compared = { compared: true, refusedTestPath: false, evidence: "diffed+observed" } as const
  const notCompared = {
    compared: false,
    refusedTestPath: false,
    evidence: "never compared",
  } as const
  const ranButUnchecked = { exercised: true, evidence: "ran the deliverable" } as const

  test("no L1 comparison ⇒ unverifiable (the anti-over-persist terminal state)", () => {
    expect(deriveVerificationState(notCompared, "I think it works").state).toBe("unverifiable")
  })

  // ── The v2 CORE: L0-without-L1 is NO LONGER verified-pass (v1's rubber-stamp is retired). ──
  test("RED-for-v1: RAN but NEVER COMPARED + a positive/silent final ⇒ unverifiable (NOT verified-pass)", () => {
    // v1 stamped this `verified-pass` on the bare run — the false-green this whole lever kills.
    expect(
      deriveVerificationState(notCompared, "Output looks correct. Verified green.", ranButUnchecked)
        .state,
    ).toBe("unverifiable")
    expect(deriveVerificationState(notCompared, "", ranButUnchecked).state).toBe("unverifiable")
    // The evidence names the ran-but-unchecked gap honestly (no false pass claim).
    expect(
      deriveVerificationState(notCompared, "done", ranButUnchecked).evidence.toLowerCase(),
    ).toContain("never compared")
  })

  test("L1 compared + a positive stated outcome ⇒ verified-pass", () => {
    expect(
      deriveVerificationState(compared, "Output matches the reference. Verified pass.").state,
    ).toBe("verified-pass")
  })

  test("L1 compared + silent final ⇒ verified-pass (a comparison was observed)", () => {
    expect(deriveVerificationState(compared, "").state).toBe("verified-pass")
  })

  test("L1 compared + a NEGATIVE stated outcome ⇒ verified-fail (honest, not false green)", () => {
    expect(deriveVerificationState(compared, "The output does not match; it differs.").state).toBe(
      "verified-fail",
    )
  })

  test("L1 compared + an UNCERTAIN stated outcome ⇒ unverifiable (agent itself could not confirm)", () => {
    expect(deriveVerificationState(compared, "I could not verify the result.").state).toBe(
      "unverifiable",
    )
  })

  test.each([
    "It passes: the output is correct and matches.",
    "The comparison completed with no errors and the output matches.",
    "Diff shows no differences; it does not fail.",
    "Compared to the baseline; zero failures.",
  ])("success-by-negation / positive phrasing %p ⇒ verified-pass (not mis-read as fail)", (t) => {
    const s: VerificationState = deriveVerificationState(compared, t).state
    expect(s).toBe("verified-pass")
  })

  test("evidence never references a hidden test — it only names the model's own trajectory", () => {
    const stamp = deriveVerificationState(compared, "pass")
    expect(stamp.evidence).toBe("diffed+observed")
    expect(stamp.evidence.toLowerCase()).not.toContain("hidden")
    expect(stamp.evidence.toLowerCase()).not.toContain("answer key")
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// P1 — the v2 L1 inspector `comparedToReference` (RFC jul-2 §03). Adversarial fixtures pin: R1
// (test-path reference REFUSED, load-bearing — query-optimize's golden lives in /tests/), R4 (L1
// gaming: `diff a a` / `/dev/null` / <2 operands / bare `echo` never count), and the true-positives
// (a real `diff out ref`, a `cmp a.npy b.npy`, a `python check.py out --expected ref`). Observation
// is required: a comparison whose result was never read back is NOT L1.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("comparedToReference — L1 accept (a real observed comparison against a non-test reference)", () => {
  test("`diff out.txt /app/reference.txt` observed ⇒ compared", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "diff out.txt /app/reference.txt" }),
      result("c1", "container_exec", { preview: "", exitCode: 0 }),
    ]
    const v = comparedToReference(events)
    expect(v.compared).toBe(true)
    expect(v.evidence).toContain("compared")
    // no-leak: the evidence names only the model's own command, never a hidden oracle.
    expect(v.evidence?.toLowerCase()).not.toContain("hidden")
  })

  test("`cmp stolen.npy original.npy` observed (two data artifacts) ⇒ compared", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "cmp stolen.npy original.npy" }),
      result("c1", "container_exec", { preview: "", exitCode: 0 }),
    ]
    expect(comparedToReference(events).compared).toBe(true)
  })

  test("a script run naming a reference operand (`python check.py out.txt --expected ref.txt`) observed ⇒ compared", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "python check.py out.txt --expected ref.txt" }),
      result("c1", "container_exec", { preview: "MATCH", exitCode: 0 }),
    ]
    expect(comparedToReference(events).compared).toBe(true)
  })

  test("a script handed TWO data artifacts (`node cmp.js result.json baseline.json`) observed ⇒ compared", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "node cmp.js result.json baseline.json" }),
      result("c1", "container_exec", { preview: "equal", exitCode: 0 }),
    ]
    expect(comparedToReference(events).compared).toBe(true)
  })

  test("a diff TYPED into a pane + observed via pty_read ⇒ compared", () => {
    const events: AgentEvent[] = [
      call("p0", "pty_start", { command: "bash" }),
      call("p1", "pty_write", {
        handle: "h",
        data: "diff mine.out baseline.out",
        appendNewline: true,
      }),
      result("p1", "pty_write", { preview: "ok" }),
      call("p2", "pty_read", { handle: "h" }),
      result("p2", "pty_read", { preview: "< foo\n> bar\n[nextSeq=3]" }),
    ]
    expect(comparedToReference(events).compared).toBe(true)
  })

  test("`bash -c 'diff a.txt b.txt'` unwraps to a real comparison ⇒ compared", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "bash -c 'diff a.txt b.txt'" }),
      result("c1", "container_exec", { preview: "", exitCode: 0 }),
    ]
    expect(comparedToReference(events).compared).toBe(true)
  })
})

describe("comparedToReference — R4 L1 gaming must NOT count", () => {
  test.each([
    ["diff a.txt a.txt", "same file twice (no real reference)"],
    ["diff /dev/null /dev/null", "dev-null sinks"],
    ["diff out.txt", "only one operand"],
    ["diff", "no operands"],
    ["echo matches", "bare echo claim"],
    ["echo 'outputs are identical'", "text claim, no tool comparison"],
    ["cmp -s x", "one operand"],
  ])("gaming %p (%s) ⇒ NOT compared", (command) => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command }),
      result("c1", "container_exec", { preview: "some text", exitCode: 0 }),
    ]
    expect(comparedToReference(events).compared).toBe(false)
  })

  test("a real diff whose RESULT was never observed (no preview, no exitCode) ⇒ NOT compared", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "diff out.txt ref.txt" }),
      result("c1", "container_exec", { preview: "" }), // never read the outcome
    ]
    expect(comparedToReference(events).compared).toBe(false)
  })

  test("a plain run (no comparator, no reference operand) ⇒ NOT compared", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "./solver input.txt" }),
      result("c1", "container_exec", { preview: "42\n", exitCode: 0 }),
    ]
    const v = comparedToReference(events)
    expect(v.compared).toBe(false)
    expect(v.evidence).toContain("never")
  })

  // R4-b (audit): a SCRIPT run with two data files but NO reference-naming signal is an L0 RUN,
  // not a comparison — `solve.py in.json out.json` must NOT masquerade as L1 (that would re-open a
  // mini-rubber-stamp: the very thing v2 kills). The script branch requires a NAMED reference.
  test.each([
    "python solve.py input.json output.json",
    "python solve.py in.csv out.csv",
    "./solver data.npy result.npy",
    "python check.py out.txt", // single operand, no reference
  ])("a bare script run with no NAMED reference %p ⇒ NOT compared (no mini-rubber-stamp)", (command) => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command }),
      result("c1", "container_exec", { preview: "ok", exitCode: 0 }),
    ]
    expect(comparedToReference(events).compared).toBe(false)
  })

  test("a script that NAMES its reference (via flag or filename) IS accepted (the true-positive)", () => {
    const flag: AgentEvent[] = [
      call("c1", "container_exec", { command: "python check.py out.txt --expected ref.txt" }),
      result("c1", "container_exec", { preview: "MATCH", exitCode: 0 }),
    ]
    const named: AgentEvent[] = [
      call("c2", "container_exec", { command: "node cmp.js result.json baseline.json" }),
      result("c2", "container_exec", { preview: "equal", exitCode: 0 }),
    ]
    expect(comparedToReference(flag).compared).toBe(true)
    expect(comparedToReference(named).compared).toBe(true)
  })
})

describe("comparedToReference — R1 no-leak (CRITICAL, box-proven): a test-path reference is REFUSED", () => {
  test.each([
    "diff out.sql /app/tests/golden.sql", // query-optimize's real layout — the load-bearing case
    "diff result.txt tests/expected_output.txt",
    "cmp mine.npy /verifier/original.npy",
    "diff out.txt /private/answer.txt",
    "diff out.json grader/solution.json",
    "python check.py out.txt --expected tests/golden.txt",
    // R1-a (audit): RUNNING the hidden verifier/grader SCRIPT itself is peeking too, even when the
    // compared operands look clean — the leader path must be excluded, not just the operands.
    "/app/tests/verify.py mine.out baseline.out",
    "python /app/grader/check.py out.txt --reference ref.txt",
    "node tests/compare.js result.json baseline.json",
  ])("comparison against a test/verifier path %p ⇒ NOT compared (refused)", (command) => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command }),
      result("c1", "container_exec", { preview: "", exitCode: 0 }),
    ]
    const v = comparedToReference(events)
    expect(v.compared).toBe(false)
    expect(v.refusedTestPath).toBe(true)
    // The refusal evidence must NOT teach peeking (never names the model to go look at the golden).
    expect(v.evidence?.toLowerCase()).not.toContain("golden.sql")
  })

  test("a REFUSED test-path diff does NOT mask a later FAIR comparison in the same trajectory", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: "diff out.txt /app/tests/golden.txt" }), // refused
      result("c1", "container_exec", { preview: "", exitCode: 0 }),
      call("c2", "container_exec", { command: "diff out.txt /app/baseline.txt" }), // fair
      result("c2", "container_exec", { preview: "", exitCode: 0 }),
    ]
    expect(comparedToReference(events).compared).toBe(true)
  })

  test("malformed / non-string command input does not crash and is not a comparison", () => {
    const events: AgentEvent[] = [
      call("c1", "container_exec", { command: 42 }),
      call("c2", "container_exec", {}),
      call("c3", "container_exec", null),
    ]
    expect(comparedToReference(events).compared).toBe(false)
  })
})

// B1 (RFC jul-3): a result killed by the per-command deadline is TRUNCATED evidence — it must never
// count as an observation, or a half-printed diff could stamp `verified-fail`/`verified-pass`.
// Every case is PAIRED with its completed control so the exclusion (not some other rule) is what's
// proven (paired-control discipline).
describe("B1 — timed-out results are NOT observations (truncated evidence can't stamp verdicts)", () => {
  test("a timed-out diff is NOT an observed L1 comparison; the SAME completed diff is", () => {
    const timedOut = comparedToReference([
      call("c1", "container_exec", { command: "diff out.csv baseline.csv" }),
      result("c1", "container_exec", {
        preview: "3c3\n< a\n> b",
        exitCode: 124,
        ok: false,
        timedOut: true,
      }),
    ])
    expect(timedOut.compared).toBe(false)
    const completed = comparedToReference([
      call("c1", "container_exec", { command: "diff out.csv baseline.csv" }),
      result("c1", "container_exec", { preview: "3c3\n< a\n> b", exitCode: 1 }),
    ])
    expect(completed.compared).toBe(true)
  })

  test("a timed-out run is NOT L0 exercise evidence (fail-closed); the completed control is", () => {
    const timedOut = inspectExerciseEvidence([
      call("c1", "container_exec", { command: "./solver in.txt" }),
      result("c1", "container_exec", {
        preview: "working on it…",
        exitCode: 124,
        ok: false,
        timedOut: true,
      }),
    ])
    expect(timedOut.exercised).toBe(false)
    const completed = inspectExerciseEvidence([
      call("c1", "container_exec", { command: "./solver in.txt" }),
      result("c1", "container_exec", { preview: "answer 42", exitCode: 0 }),
    ])
    expect(completed.exercised).toBe(true)
  })

  test("OC1 belt: a foreign transport surfacing a deadline kill as ok:true/exit 0 is still NOT clean", () => {
    const v = outputContractVerdict([
      call("c1", "container_exec", { command: "./run" }),
      result("c1", "container_exec", { preview: "done?", exitCode: 0, ok: true, timedOut: true }),
    ])
    expect(v.ranClean).toBe(false)
  })
})

// P2-C (RFC jul-3): the one-hop LAUNDERING guard — a compare operand whose CONTENT came from the
// hidden oracle (cp/ln/mv/tee/redirect, transitively) is refused exactly like the oracle path.
// Every leak case is PAIRED with a clean control so the taint (not some other rule) is what's proven.
describe("P2-C — laundering: comparing against oracle-DERIVED content is refused", () => {
  const obs = (id: string) => result(id, "container_exec", { preview: "out", exitCode: 0 })
  const exec = (id: string, command: string) => call(id, "container_exec", { command })
  const verdictFor = (commands: readonly string[]) =>
    comparedToReference(commands.flatMap((c, i) => [exec(`c${i}`, c), obs(`c${i}`)]))

  test("cp from /tests/ then diff against the copy ⇒ refused; clean-source cp ⇒ compared", () => {
    const laundered = verdictFor(["cp /app/tests/golden.csv ref.csv", "diff out.csv ref.csv"])
    expect(laundered.compared).toBe(false)
    expect(laundered.refusedTestPath).toBe(true)
    const clean = verdictFor(["cp /app/data/sample.csv ref.csv", "diff out.csv ref.csv"])
    expect(clean.compared).toBe(true)
  })

  test("ln -s laundering ⇒ refused (symlink names the oracle without copying bytes)", () => {
    const v = verdictFor(["ln -s /tests/expected.txt mirror.txt", "diff out.txt mirror.txt"])
    expect(v.compared).toBe(false)
    expect(v.refusedTestPath).toBe(true)
  })

  test("redirect laundering (`cat /tests/golden.sql > mine.sql`) ⇒ refused; clean redirect ⇒ compared", () => {
    const laundered = verdictFor(["cat /app/tests/golden.sql > mine.sql", "diff out.sql mine.sql"])
    expect(laundered.compared).toBe(false)
    expect(laundered.refusedTestPath).toBe(true)
    const clean = verdictFor(["cat input.sql > mine.sql", "diff out.sql mine.sql"])
    expect(clean.compared).toBe(true)
  })

  test("pipe+tee laundering (`cat tests/expected.txt | tee snap.txt`) ⇒ refused", () => {
    const v = verdictFor(["cat tests/expected.txt | tee snap.txt", "diff out.txt snap.txt"])
    expect(v.compared).toBe(false)
    expect(v.refusedTestPath).toBe(true)
  })

  test("TRANSITIVE: cp /tests/g a, cp a b ⇒ diff against b refused", () => {
    const v = verdictFor(["cp /tests/g.csv a.csv", "cp a.csv b.csv", "diff out.csv b.csv"])
    expect(v.compared).toBe(false)
    expect(v.refusedTestPath).toBe(true)
  })

  test("NO over-taint: referencing tests/ without dataflow into the operand keeps the compare fair", () => {
    // `ls tests/` mentions the dir but copies nothing into `b.csv` — the later diff must count.
    const v = verdictFor(["ls tests/", "diff a.csv b.csv"])
    expect(v.compared).toBe(true)
  })

  test("buildTaintedRefs is exported + transitive + quote/./-normalizing (direct pin)", () => {
    const t = buildTaintedRefs([
      "cp /tests/golden.csv './ref.csv'",
      "cp ref.csv 'copy2.csv'",
      "echo hi > unrelated.txt",
    ])
    expect(t.has("ref.csv")).toBe(true)
    expect(t.has("copy2.csv")).toBe(true) // transitive through the tainted intermediate
    expect(t.has("unrelated.txt")).toBe(false) // no unfair source in that command
  })

  // hell-audit R2 §1.1: a DIRECTORY destination (cp SRC dir/) launders — the later compare reads
  // the file OUT of the dir under a clean-looking name; a `dir/`-prefix taint must catch it.
  test("DIR-dest laundering: cp /tests/g d/ then diff out d/g ⇒ refused; clean-dir cp ⇒ compared", () => {
    const laundered = verdictFor(["cp /app/tests/golden.csv out/", "diff mine.csv out/golden.csv"])
    expect(laundered.compared).toBe(false)
    expect(laundered.refusedTestPath).toBe(true)
    const clean = verdictFor(["cp /app/data/sample.csv out/", "diff mine.csv out/sample.csv"])
    expect(clean.compared).toBe(true)
  })

  // hell-audit R2 §1.2: GNU `cp -t DEST SRC` puts the destination FIRST — the last-operand
  // heuristic must not mistake the oracle SRC for the dest and launder nothing.
  test("`cp -t dir /tests/g` (dest-first) taints the dir; diff against dir/g ⇒ refused", () => {
    const v = verdictFor(["cp -t snap /app/tests/golden.csv", "diff mine.csv snap/golden.csv"])
    expect(v.compared).toBe(false)
    expect(v.refusedTestPath).toBe(true)
  })

  // hell-audit R2 §2: the CORE legit pattern — a solver whose INPUT lives under a tests/-named dir
  // (or is named test_*) writes its OWN stdout, then diffs against a task reference. The exercise
  // segment's redirect target must NOT be tainted, or the honest compare is wrongly refused.
  test("NO over-taint: `./solve tests/in.txt > out` keeps `diff out expected.txt` FAIR", () => {
    const underTestsDir = verdictFor(["./solve tests/input.txt > out", "diff out expected.txt"])
    expect(underTestsDir.compared).toBe(true)
    const namedTest = verdictFor(["./solve test_input.txt > out", "diff out expected.txt"])
    expect(namedTest.compared).toBe(true)
    // control: a NON-exercise reader of the same oracle path DOES still taint its redirect target.
    const launder = verdictFor(["cat tests/golden.txt > out", "diff mine.txt out"])
    expect(launder.compared).toBe(false)
    expect(launder.refusedTestPath).toBe(true)
  })
})

describe("isSelfTestCommand — credits an agent-authored self-test, refuses hidden-oracle peeking", () => {
  test("credits: interpreter running a test-named file (agent's OWN self-test)", () => {
    expect(isSelfTestCommand("python test_fib.py")).toBe(true)
    expect(isSelfTestCommand("python3 fib_test.py")).toBe(true)
    expect(isSelfTestCommand("node tests.js")).toBe(true)
    expect(isSelfTestCommand("bash selftest.sh")).toBe(true)
    expect(isSelfTestCommand("./run_tests.sh")).toBe(true)
  })

  test("credits: an inline assertion snippet", () => {
    expect(isSelfTestCommand("python -c 'from fib import fib; assert fib(5)==5'")).toBe(true)
    expect(isSelfTestCommand("node -e 'const a=require(\"assert\"); assert.equal(f(0),0)'")).toBe(
      true,
    )
  })

  test("credits: a real test-runner naming a NON-oracle file", () => {
    expect(isSelfTestCommand("pytest my_check.py")).toBe(true)
    expect(isSelfTestCommand("python -m pytest solution_test.py")).toBe(true)
  })

  test("REFUSES: any run touching the hidden-oracle location (peeking, not self-testing)", () => {
    expect(isSelfTestCommand("pytest tests/")).toBe(false)
    expect(isSelfTestCommand("pytest /app/tests/test_polyglot.py")).toBe(false)
    expect(isSelfTestCommand("python -c 'assert True' && cat tests/expected.txt")).toBe(false)
    expect(isSelfTestCommand("./verifier/check.sh")).toBe(false)
    expect(isSelfTestCommand("python grader.py")).toBe(false)
  })

  test("REFUSES (conservative): a bare test-runner with no file operand (could discover the hidden suite)", () => {
    expect(isSelfTestCommand("pytest")).toBe(false)
    expect(isSelfTestCommand("python -m pytest")).toBe(false)
    expect(isSelfTestCommand("tox")).toBe(false)
  })

  test("REFUSES: an ordinary run of the deliverable (no test artifact / assertion)", () => {
    expect(isSelfTestCommand("./solver input.txt")).toBe(false)
    expect(isSelfTestCommand("python fib.py")).toBe(false)
    expect(isSelfTestCommand("cat out.txt")).toBe(false)
  })
})

describe("inspectSelfTest — OBSERVE-ONLY receipt (executed + green), container_exec", () => {
  const exec = "container_exec"
  test("executed + green: an authored self-test ran and exited 0", () => {
    const events: AgentEvent[] = [
      call("1", exec, { command: "python test_fib.py" }),
      result("1", exec, { exitCode: 0, preview: "ok", ok: true }),
    ]
    const r = inspectSelfTest(events)
    expect(r.executed).toBe(true)
    expect(r.green).toBe(true)
    expect(r.evidence).toContain("self-test")
  })

  test("executed but NOT green: the self-test ran and FAILED (exit 1)", () => {
    const events: AgentEvent[] = [
      call("1", exec, { command: "python test_fib.py" }),
      result("1", exec, { exitCode: 1, ok: false, preview: "AssertionError" }),
    ]
    const r = inspectSelfTest(events)
    expect(r.executed).toBe(true)
    expect(r.green).toBe(false)
  })

  test("iterate-to-green: the LAST observed self-test decides green (fail → fix → pass)", () => {
    const events: AgentEvent[] = [
      call("1", exec, { command: "python test_fib.py" }),
      result("1", exec, { exitCode: 1, ok: false, preview: "AssertionError" }),
      call("2", exec, { command: "python test_fib.py" }),
      result("2", exec, { exitCode: 0, ok: true, preview: "ok" }),
    ]
    const r = inspectSelfTest(events)
    expect(r.executed).toBe(true)
    expect(r.green).toBe(true)
  })

  test("NOT executed: only ran the deliverable, never an authored self-test (extract-elf/sam class)", () => {
    const events: AgentEvent[] = [
      call("1", exec, { command: "python extract.py" }),
      result("1", exec, { exitCode: 0, ok: true, preview: "done" }),
    ]
    const r = inspectSelfTest(events)
    expect(r.executed).toBe(false)
    expect(r.green).toBe(false)
    expect(r.evidence).toContain("no agent-authored self-test")
  })

  test("no-leak: a run touching the hidden oracle is NOT credited as a self-test", () => {
    const events: AgentEvent[] = [
      call("1", exec, { command: "pytest /app/tests/test_polyglot.py" }),
      result("1", exec, { exitCode: 0, ok: true, preview: "1 passed" }),
    ]
    expect(inspectSelfTest(events).executed).toBe(false)
  })

  test("fail-closed: an authored self-test whose result was never OBSERVED does not count", () => {
    const events: AgentEvent[] = [
      call("1", exec, { command: "python test_fib.py" }),
      result("1", exec, { timedOut: true }),
    ]
    expect(inspectSelfTest(events).executed).toBe(false)
  })
})

// jul-3 hell-audit — the self-test `green` gaming surfaces the receipt must refuse (F2/F3/F4).
// Each attack is PAIRED with an honest control so the refusal (not some other rule) is proven.
describe("inspectSelfTest — gaming defenses (F2 launder / F3 suite-discovery / F4 flip)", () => {
  const exec = "container_exec"
  test("F2: a self-test reading an oracle-LAUNDERED file is NOT credited; a clean-source copy is", () => {
    // cp /tests/golden into a clean name, then a self-test that reads it = peeking one hop removed.
    const laundered = inspectSelfTest([
      call("1", exec, { command: "cp /app/tests/golden.txt exp.txt" }),
      result("1", exec, { exitCode: 0, ok: true, preview: "" }),
      call("2", exec, { command: "python test_it.py exp.txt" }),
      result("2", exec, { exitCode: 0, ok: true, preview: "ok" }),
    ])
    expect(laundered.green).toBe(false)
    expect(laundered.executed).toBe(false)
    // paired control: SAME shape, clean source ⇒ credited (proves the taint, not the read, refused).
    const clean = inspectSelfTest([
      call("1", exec, { command: "cp data/sample.txt exp.txt" }),
      result("1", exec, { exitCode: 0, ok: true, preview: "" }),
      call("2", exec, { command: "python test_it.py exp.txt" }),
      result("2", exec, { exitCode: 0, ok: true, preview: "ok" }),
    ])
    expect(clean.green).toBe(true)
  })

  test("F3: `pytest .` / bare / directory (hidden-suite discovery) is NOT a self-test; a named file is", () => {
    expect(isSelfTestCommand("pytest .")).toBe(false)
    expect(isSelfTestCommand("pytest")).toBe(false)
    expect(isSelfTestCommand("pytest src")).toBe(false)
    expect(isSelfTestCommand("python -m pytest .")).toBe(false)
    // a concrete agent-authored file the runner is pointed at IS credited (control)
    expect(isSelfTestCommand("pytest my_check.py")).toBe(true)
    expect(isSelfTestCommand("pytest test_fib.py")).toBe(true)
  })

  test("F4: green reached only after an earlier RED self-test surfaces `flippedFromRed`", () => {
    // A genuine red→fix→green on the SAME file is still green, but the flip is flagged so a gating
    // consumer can distinguish it from a switch to a weaker test.
    const flipped = inspectSelfTest([
      call("1", exec, { command: "python test_fib.py" }),
      result("1", exec, { exitCode: 1, ok: false, preview: "AssertionError" }),
      call("2", exec, { command: "python -c 'assert True'" }),
      result("2", exec, { exitCode: 0, ok: true, preview: "" }),
    ])
    expect(flipped.green).toBe(true)
    expect(flipped.flippedFromRed).toBe(true)
    // a clean single green run carries NO flip flag (control)
    const straight = inspectSelfTest([
      call("1", exec, { command: "python test_fib.py" }),
      result("1", exec, { exitCode: 0, ok: true, preview: "ok" }),
    ])
    expect(straight.flippedFromRed).toBeUndefined()
  })
})
