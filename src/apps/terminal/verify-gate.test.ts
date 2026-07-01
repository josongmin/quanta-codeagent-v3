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
  deriveVerificationState,
  inspectExerciseEvidence,
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
  extra: { preview?: string; exitCode?: number; ok?: boolean } = {},
): AgentEvent => ({
  type: "tool_result",
  id,
  name,
  ok: extra.ok ?? true,
  preview: extra.preview ?? "",
  ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
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

describe("inspectExerciseEvidence — pty_* (review P1: interactive deliverable must count)", () => {
  test("driving a program (pty_write) AND observing its response (pty_read) ⇒ exercised", () => {
    const events: AgentEvent[] = [
      call("p0", "pty_attach", { command: "python3" }),
      call("p1", "pty_write", { handle: "h", data: "print(2+2)", appendNewline: true }),
      result("p1", "pty_write", { preview: "ok" }),
      call("p2", "pty_read", { handle: "h" }),
      result("p2", "pty_read", { preview: "4\n[nextSeq=3]" }),
    ]
    const v = inspectExerciseEvidence(events)
    expect(v.exercised).toBe(true)
    expect(v.evidence).toContain("pty_")
  })

  test("attaching a pane WITHOUT driving it (no pty_write) ⇒ NOT exercised", () => {
    const events: AgentEvent[] = [
      call("p0", "pty_attach", { command: "vim" }),
      call("p2", "pty_read", { handle: "h" }),
      result("p2", "pty_read", { preview: "~\n~\n" }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(false)
  })

  test("driving without ever reading back the response ⇒ NOT exercised", () => {
    const events: AgentEvent[] = [
      call("p1", "pty_write", { handle: "h", data: "run", appendNewline: true }),
      result("p1", "pty_write", { preview: "ok" }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(false)
  })

  test("a pty_read that observed NOTHING (empty preview, no exitCode) ⇒ NOT exercised", () => {
    const events: AgentEvent[] = [
      call("p1", "pty_write", { handle: "h", data: "x", appendNewline: true }),
      result("p1", "pty_write", { preview: "ok" }),
      call("p2", "pty_read", { handle: "h" }),
      result("p2", "pty_read", { preview: "" }),
    ]
    expect(inspectExerciseEvidence(events).exercised).toBe(false)
  })
})

describe("inspectExerciseEvidence — empty / no-tool trajectories", () => {
  test("no tool calls at all ⇒ NOT exercised with an honest reason", () => {
    const v = inspectExerciseEvidence([{ type: "assistant_text", delta: "all done, verified green" }])
    expect(v.exercised).toBe(false)
    expect(v.evidence).toContain("no end-to-end exercise")
  })
})

describe("deriveVerificationState — honest trichotomy", () => {
  const exercised = { exercised: true, evidence: "ran+observed" } as const
  const notExercised = { exercised: false, evidence: "never ran" } as const

  test("no exercise ⇒ unverifiable (the anti-over-persist terminal state)", () => {
    expect(deriveVerificationState(notExercised, "I think it works").state).toBe("unverifiable")
  })

  test("exercised + a positive stated outcome ⇒ verified-pass", () => {
    expect(deriveVerificationState(exercised, "Output matches the reference. Verified pass.").state).toBe(
      "verified-pass",
    )
  })

  test("exercised + silent final ⇒ verified-pass (it was run and observed)", () => {
    expect(deriveVerificationState(exercised, "").state).toBe("verified-pass")
  })

  test("exercised + a NEGATIVE stated outcome ⇒ verified-fail (honest, not false green)", () => {
    expect(deriveVerificationState(exercised, "The output does not match; the test failed.").state).toBe(
      "verified-fail",
    )
  })

  test("exercised + an UNCERTAIN stated outcome ⇒ unverifiable (agent itself could not confirm)", () => {
    expect(deriveVerificationState(exercised, "I could not verify the result.").state).toBe(
      "unverifiable",
    )
  })

  test.each([
    "It passes: the output is correct and matches.",
    "The run completed with no errors and the output matches.",
    "Diff shows no differences; it does not fail.",
    "Ran the binary; zero failures.",
  ])("success-by-negation / positive phrasing %p ⇒ verified-pass (not mis-read as fail)", (t) => {
    const s: VerificationState = deriveVerificationState(exercised, t).state
    expect(s).toBe("verified-pass")
  })

  test("evidence never references a hidden test — it only names the model's own trajectory", () => {
    const stamp = deriveVerificationState(exercised, "pass")
    expect(stamp.evidence).toBe("ran+observed")
    expect(stamp.evidence.toLowerCase()).not.toContain("hidden")
    expect(stamp.evidence.toLowerCase()).not.toContain("answer")
  })
})
