import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "@/agent"
import { defaultTools, ToolRegistry } from "@/tool"
import {
  FakeLLM,
  baseConfig as harnessBaseConfig,
  multiToolUse as multiToolScript,
  RecordingStream,
  text as textScript,
  toolUse as toolUseScript,
} from "./_harness"

// Local convenience wrapper preserving the original 6-arg ordering: builds an
// `AgentConfig` from the harness defaults but overrides the call-site knobs
// each test sets (cwd, permission, maxTurns). Keeps the per-test bodies untouched.
const baseConfig = (
  llm: import("@/llm").LLMPort,
  registry: import("@/tool").ToolRegistry,
  stream: import("@/stream").StreamPort,
  cwd: string,
  permission: import("@/permission").PermissionContext,
  maxTurns: number,
): import("@/agent").AgentConfig =>
  harnessBaseConfig({
    llm,
    registry,
    stream,
    permission,
    cwd,
    maxTurns,
    system: "test",
  })

describe("runAgent integration", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-loop-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("(a) happy path: write tool then text → completed, file on disk, events ordered", async () => {
    const file = join(dir, "out.txt")
    const llm = new FakeLLM([
      toolUseScript("c1", "write", { path: file, content: "hello disk" }),
      textScript("done"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 10),
    )

    expect(outcome.reason).toBe("completed")
    expect(outcome.turns).toBe(2)
    expect(readFileSync(file, "utf8")).toBe("hello disk")

    const types = stream.events.map((e) => e.type)
    const callIdx = types.indexOf("tool_call")
    const resultIdx = types.indexOf("tool_result")
    const doneIdx = types.indexOf("done")
    expect(callIdx).toBeGreaterThanOrEqual(0)
    expect(callIdx).toBeLessThan(resultIdx)
    expect(resultIdx).toBeLessThan(doneIdx)

    const resultEv = stream.events[resultIdx]
    expect(resultEv?.type).toBe("tool_result")
    if (resultEv?.type === "tool_result") {
      expect(resultEv.ok).toBe(true)
      expect(resultEv.name).toBe("write")
    }
    const doneEv = stream.events[doneIdx]
    if (doneEv?.type === "done") expect(doneEv.reason).toBe("completed")
  })

  test("(b) tool error recovery: failed read then text → completed, error block in transcript", async () => {
    const missing = join(dir, "does-not-exist.txt")
    const llm = new FakeLLM([
      toolUseScript("c1", "read", { path: missing }),
      textScript("recovered"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 10),
    )

    expect(outcome.reason).toBe("completed")

    const errorBlocks = outcome.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result" && b.is_error === true),
    )
    expect(errorBlocks).toHaveLength(1)

    const resultEv = stream.events.find((e) => e.type === "tool_result")
    expect(resultEv?.type).toBe("tool_result")
    if (resultEv?.type === "tool_result") expect(resultEv.ok).toBe(false)
  })

  test("(c) max_turns: always tool_use → stops at maxTurns", async () => {
    const file = join(dir, "loop.txt")
    const llm = new FakeLLM([toolUseScript("c1", "write", { path: file, content: "x" })])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 3),
    )

    expect(outcome.reason).toBe("max_turns")
    expect(outcome.turns).toBe(3)
    expect(llm.calls).toBe(3)
  })

  test("(d) permission deny: hard-denied bash, loop continues, then completed", async () => {
    const llm = new FakeLLM([
      toolUseScript("c1", "bash", { command: "rm -rf /" }),
      textScript("ok then"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(baseConfig(llm, registry, stream, dir, { mode: "bypass" }, 10))

    expect(outcome.reason).toBe("completed")

    const denied = outcome.messages.flatMap((m) =>
      m.content.filter(
        (b) =>
          b.type === "tool_result" &&
          b.is_error === true &&
          b.content.includes("Permission denied"),
      ),
    )
    expect(denied).toHaveLength(1)

    const resultEv = stream.events.find((e) => e.type === "tool_result")
    if (resultEv?.type === "tool_result") expect(resultEv.ok).toBe(false)
  })

  test("(e) two concurrency-safe reads in one turn → both results, order preserved", async () => {
    const f1 = join(dir, "one.txt")
    const f2 = join(dir, "two.txt")
    writeFileSync(f1, "AAA")
    writeFileSync(f2, "BBB")
    const llm = new FakeLLM([
      multiToolScript([
        { id: "r1", name: "read", input: { path: f1 } },
        { id: "r2", name: "read", input: { path: f2 } },
      ]),
      textScript("done"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 10),
    )

    expect(outcome.reason).toBe("completed")

    const resultMsg = outcome.messages.find(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    )
    const ids = resultMsg?.content
      .filter((b) => b.type === "tool_result")
      .map((b) => (b.type === "tool_result" ? b.tool_use_id : ""))
    expect(ids).toEqual(["r1", "r2"])

    const r1 = resultMsg?.content.find((b) => b.type === "tool_result" && b.tool_use_id === "r1")
    const r2 = resultMsg?.content.find((b) => b.type === "tool_result" && b.tool_use_id === "r2")
    expect(r1?.type === "tool_result" && r1.content).toContain("AAA")
    expect(r2?.type === "tool_result" && r2.content).toContain("BBB")

    // Both tool_call events emitted before either tool_result (batch ordering).
    const types = stream.events.map((e) => e.type)
    const lastCall = types.lastIndexOf("tool_call")
    const firstResult = types.indexOf("tool_result")
    expect(lastCall).toBeLessThan(firstResult)
  })

  // Verify-guard (Tier 0 safety hardening): observed bench failure — the agent edits a
  // source file then declares "done" with ZERO verification calls after the
  // edit, so a wrong fix ships. With `verifyGuard` configured the loop must
  // force one more turn until a test_runner/bash runs after the last edit.
  test("(g) verifyGuard: edit then finish is blocked until a test runs after the edit", async () => {
    const file = join(dir, "fix.txt")
    const llm = new FakeLLM([
      // turn 1: mutate source
      toolUseScript("c1", "write", { path: file, content: "patched" }),
      // turn 2: model tries to finish with NO verification since the edit
      textScript("all done"),
      // forced turn: now it runs a REAL test. R1's tightened policy only
      // counts a `bash` as verification when its command matches the
      // test/repro regex — a noise command like `echo`/`git status` would NOT
      // satisfy the guard (that loophole is the empirically-confirmed 0-trip
      // defect this guard exists to close), so use an actual pytest invocation.
      toolUseScript("c3", "bash", { command: "python -m pytest tests/ -q" }),
      // turn 4: finish for real
      textScript("verified and done"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const cfg = {
      ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }, 10),
      verifyGuard: { maxTrips: 2 },
    }
    const outcome = await runAgent(cfg)

    expect(outcome.reason).toBe("completed")

    // Exactly one `unverified` recovery happened.
    const unverified = stream.events.filter(
      (e) => e.type === "recovery" && e.reason === "unverified",
    )
    expect(unverified).toHaveLength(1)

    // The forcing message text was injected into the canonical transcript.
    const forced = outcome.messages.some(
      (m) =>
        m.role === "user" &&
        m.content.some((b) => b.type === "text" && b.text.includes("ran no test or reproduction")),
    )
    expect(forced).toBe(true)

    // A bash call occurred (the verification) before the run completed.
    const toolCalls = stream.events.filter((e) => e.type === "tool_call")
    const names = toolCalls.map((e) => (e.type === "tool_call" ? e.name : ""))
    expect(names).toEqual(["write", "bash"])
  })

  // Regression for the EMPIRICALLY-CONFIRMED prod defect: a real SWE-bench run
  // had the guard fire 0 times because the agent ran a noise `bash`
  // (`git status`) after editing and the OLD policy counted ANY bash as
  // "verified". With R1's tightened policy a noise bash must NOT satisfy the
  // guard: edit → bash(git status) → done MUST still be blocked & forced.
  test("(g2) verifyGuard regression: a noise bash (git status) after an edit does NOT satisfy the guard", async () => {
    const file = join(dir, "fix.txt")
    const llm = new FakeLLM([
      // turn 1: mutate source
      toolUseScript("c1", "write", { path: file, content: "patched" }),
      // turn 2: a NOISE bash (the exact prod loophole) — must NOT count.
      toolUseScript("c2", "bash", { command: "git status" }),
      // turn 3: model tries to finish — still unverified ⇒ guard MUST block.
      textScript("all done"),
      // forced turn 4: now a REAL test runs ⇒ guard satisfied.
      toolUseScript("c4", "bash", { command: "python -m pytest -q" }),
      // turn 5: finish for real.
      textScript("verified and done"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const cfg = {
      ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }, 10),
      verifyGuard: { maxTrips: 2 },
    }
    const outcome = await runAgent(cfg)

    expect(outcome.reason).toBe("completed")
    // The noise `git status` did NOT satisfy the guard: it still forced once.
    const unverified = stream.events.filter(
      (e) => e.type === "recovery" && e.reason === "unverified",
    )
    expect(unverified).toHaveLength(1)
    // Ordered proof: write → git-status bash → forced → pytest bash.
    const toolCalls = stream.events.filter((e) => e.type === "tool_call")
    const names = toolCalls.map((e) => (e.type === "tool_call" ? e.name : ""))
    expect(names).toEqual(["write", "bash", "bash"])
  })

  test("(h) verifyGuard maxTrips cap: edit→done repeated stops blocking, no infinite loop", async () => {
    const file = join(dir, "loop.txt")
    // The model is stubborn: every turn it just edits then says done. With
    // maxTrips:1 the guard blocks ONCE then must let the run finish.
    const llm = new FakeLLM([
      toolUseScript("c1", "write", { path: file, content: "x" }),
      textScript("done"),
      textScript("done again"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const cfg = {
      ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }, 10),
      verifyGuard: { maxTrips: 1 },
    }
    const outcome = await runAgent(cfg)

    expect(outcome.reason).toBe("completed")
    const unverified = stream.events.filter(
      (e) => e.type === "recovery" && e.reason === "unverified",
    )
    // Blocked exactly once (the maxTrips:1 cap), then allowed to finish.
    expect(unverified).toHaveLength(1)
    // EXACT bounded turn count (matches the e2e sibling's exact-count style):
    // slot-1 = the `write` tool turn; slot-2 = the finish attempt, forced once
    // (maxTrips:1) as a SAME-turn re-stream then allowed through. The forced
    // re-entry does NOT consume a turn slot, so the run completes at turn 2 —
    // far below maxTurns:10 (proves no infinite forcing).
    expect(outcome.turns).toBe(2)
    expect(llm.calls).toBe(3)
  })

  test("(i) default-OFF byte-identical: same edit→done WITHOUT verifyGuard finishes at turn 2", async () => {
    const file = join(dir, "fix.txt")
    const llm = new FakeLLM([
      toolUseScript("c1", "write", { path: file, content: "patched" }),
      textScript("all done"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    // NO verifyGuard ⇒ the guard never constructs/consults: identical to before.
    const outcome = await runAgent(baseConfig(llm, registry, stream, dir, { mode: "bypass" }, 10))

    expect(outcome.reason).toBe("completed")
    expect(outcome.turns).toBe(2)
    expect(llm.calls).toBe(2)
    const unverified = stream.events.filter(
      (e) => e.type === "recovery" && e.reason === "unverified",
    )
    expect(unverified).toHaveLength(0)
  })

  // Closeout reminder (§4 mirror). v3 has NO finish-time self-check; without
  // `closeoutGuard` the loop must behave EXACTLY as before — a model that
  // finishes immediately just finishes, no extra turn, no `closeout` recovery
  // event, no transcript injection. This is the byte-identical default-OFF pin.
  test("(j) closeout default-OFF byte-identical: no closeoutGuard ⇒ no closeout event, no forced turn", async () => {
    const llm = new FakeLLM([textScript("all done")])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    // NO closeoutGuard ⇒ guard never constructs/consults: byte-identical.
    const outcome = await runAgent(baseConfig(llm, registry, stream, dir, { mode: "bypass" }, 10))

    expect(outcome.reason).toBe("completed")
    expect(outcome.turns).toBe(1)
    expect(llm.calls).toBe(1)
    const closeout = stream.events.filter((e) => e.type === "recovery" && e.reason === "closeout")
    expect(closeout).toHaveLength(0)
  })

  // Closeout reminder enabled: the agent attempts to finish on turn 1 →
  // closeout blocks ONCE (single-shot by design — there is NO maxTrips knob),
  // injects the reminder, forces one more turn; turn 2 finishes normally.
  test("(k) closeoutGuard enabled fires exactly once before finish", async () => {
    const llm = new FakeLLM([
      // turn 1: model tries to finish immediately
      textScript("all done"),
      // forced turn 2: model finishes for real after the closeout reminder
      textScript("verified and complete"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const cfg = {
      ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }, 10),
      closeoutGuard: { enabled: true },
    }
    const outcome = await runAgent(cfg)

    expect(outcome.reason).toBe("completed")
    // Exactly one `closeout` recovery happened (single-shot per run).
    const closeout = stream.events.filter((e) => e.type === "recovery" && e.reason === "closeout")
    expect(closeout).toHaveLength(1)

    // The closeout reminder text was injected into the canonical transcript.
    const forced = outcome.messages.some(
      (m) =>
        m.role === "user" &&
        m.content.some((b) => b.type === "text" && b.text.includes("defended claims")),
    )
    expect(forced).toBe(true)

    // The forced re-entry is SAME-TURN (does NOT consume a maxTurns slot, just
    // like verify-guard's nudge machinery): the blocked finish + the successful
    // finish both live inside ONE turn slot. The model was streamed TWICE
    // (closeout forces a re-stream after injecting the reminder), so llm.calls
    // == 2 while outcome.turns == 1.
    expect(outcome.turns).toBe(1)
    expect(llm.calls).toBe(2)
  })

  // Closeout reminder × verify-guard interaction. Ordered (verify first,
  // closeout second): both can fire in the same RUN (different turns), but only
  // verify can fire on its triggering finish; closeout fires the next finish
  // attempt AFTER verify is satisfied. Script: edit → verify-blocks → real
  // pytest → closeout-blocks → final finish.
  test("(l) closeoutGuard × verifyGuard interaction: both fire, ordered verify-first then closeout", async () => {
    const file = join(dir, "fix.txt")
    const llm = new FakeLLM([
      // turn 1: mutate source
      toolUseScript("c1", "write", { path: file, content: "patched" }),
      // turn 2: model tries to finish → verify-guard blocks (no test since edit)
      textScript("all done"),
      // forced turn 2 (re-entry): now a REAL test runs → verify satisfied
      toolUseScript("c3", "bash", { command: "python -m pytest tests/ -q" }),
      // turn 3: model tries to finish → closeout blocks (single-shot)
      textScript("verified and done"),
      // forced turn 3 (re-entry): final finish for real
      textScript("complete"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const cfg = {
      ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }, 10),
      verifyGuard: { maxTrips: 1 },
      closeoutGuard: { enabled: true },
    }
    const outcome = await runAgent(cfg)

    expect(outcome.reason).toBe("completed")

    // verify-guard trip count == 1, closeout trip count == 1.
    const unverified = stream.events.filter(
      (e) => e.type === "recovery" && e.reason === "unverified",
    )
    expect(unverified).toHaveLength(1)
    const closeout = stream.events.filter((e) => e.type === "recovery" && e.reason === "closeout")
    expect(closeout).toHaveLength(1)

    // Recovery reasons appear in order (verify-guard fires first; closeout
    // fires on the NEXT finish-intent after verify is satisfied).
    const recoveryReasons = stream.events
      .filter((e) => e.type === "recovery")
      .map((e) => (e.type === "recovery" ? e.reason : ""))
    const unverifiedIdx = recoveryReasons.indexOf("unverified")
    const closeoutIdx = recoveryReasons.indexOf("closeout")
    expect(unverifiedIdx).toBeGreaterThanOrEqual(0)
    expect(closeoutIdx).toBeGreaterThanOrEqual(0)
    expect(unverifiedIdx).toBeLessThan(closeoutIdx)
  })

  test("(f) safe read then unsafe write in one turn → result order preserved", async () => {
    const src = join(dir, "src.txt")
    const out = join(dir, "out.txt")
    writeFileSync(src, "payload")
    const llm = new FakeLLM([
      multiToolScript([
        { id: "a", name: "read", input: { path: src } },
        { id: "b", name: "write", input: { path: out, content: "written" } },
      ]),
      textScript("done"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 10),
    )

    expect(outcome.reason).toBe("completed")
    expect(readFileSync(out, "utf8")).toBe("written")

    const resultMsg = outcome.messages.find(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    )
    const ids = resultMsg?.content
      .filter((b) => b.type === "tool_result")
      .map((b) => (b.type === "tool_result" ? b.tool_use_id : ""))
    expect(ids).toEqual(["a", "b"])
  })
})
