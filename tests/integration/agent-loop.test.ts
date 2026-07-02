import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent, VERIFY_FORCE_MESSAGE } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import {
  FakeLLM,
  baseConfig as harnessBaseConfig,
  multiToolUse as multiToolScript,
  RecordingStream,
  text as textScript,
  toolUse as toolUseScript,
  withTimeout,
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
        m.content.some((b) => b.type === "text" && b.text === VERIFY_FORCE_MESSAGE),
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

// ============================================================================
// Hell-cases — adversarial scenarios that mirror the rigor applied to session
// UX. Pins exact AgentOutcome shape, recovery FSM bookkeeping, and ordering
// invariants under malformed / adversarial / abort / resource-exhaustion
// inputs. NO production code is modified; every test exists to break the loop
// the instant a regression sneaks in.
// ============================================================================

/** Adversarial LLM that yields a caller-supplied list of stream-event scripts.
 *  Differs from `FakeLLM` only in that it tracks per-call invocation count
 *  precisely (so hell-cases can pin "the loop streamed exactly N times"). */
class CountingLLM implements LLMPort {
  readonly model = "counting-test-model"
  calls = 0
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    for (const e of script) yield e
  }
}

/** Helper: build a tool_use event sequence where the input is the EXACT raw
 *  value provided (bypasses the `toolUse` helper which always JSON-marshals
 *  through an object). Lets us script "input is a raw string" hell-cases. */
const toolUseRawInput = (id: string, name: string, rawInput: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input: rawInput },
  { type: "message_stop", stop_reason: "tool_use" },
]

describe("runAgent hell-cases — malformed LLM responses", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-loop-hell-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("(H1.a) assistant message with empty content[] → empty-recovery nudges then NON-success terminal (jul-3 C1)", async () => {
    // The loop has a same-turn empty-turn recovery (`isEmptyTurn` → nudge,
    // capped at MAX_CONSECUTIVE_EMPTIES=2). Three consecutive empties exhaust
    // the budget; jul-3 (C1) the loop then seals a NON-success `error` terminal
    // (was `completed`) — a produced-NOTHING stall is not reported as success.
    const empty: StreamEvent[] = [{ type: "message_stop", stop_reason: "end_turn" }]
    const llm = new CountingLLM([empty, empty, empty])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const out = await withTimeout(
      runAgent({
        ...harnessBaseConfig({
          llm,
          registry,
          stream,
          permission: { mode: "bypass" },
          cwd: dir,
          maxTurns: 10,
          system: "test",
        }),
      }),
      10_000,
      "empty-content",
    )

    // TEETH: pre-fix `completed`. jul-3 (C1) — exhausted empty budget ⇒ error.
    expect(out.reason).toBe("error")
    // SAME-TURN empty recoveries: 2 fired (consumed both MAX_CONSECUTIVE_EMPTIES
    // budget slots), then the 3rd empty exhausted ⇒ NON-success error terminal.
    const empties = stream.events.filter((e) => e.type === "recovery" && e.reason === "empty")
    expect(empties).toHaveLength(2)
    // No tool_use ever happened.
    const toolCalls = stream.events.filter((e) => e.type === "tool_call")
    expect(toolCalls).toHaveLength(0)
    // 3 stream calls — all same-turn (turns is the bounded productive count).
    expect(llm.calls).toBe(3)
    // jul-3 (C1): error terminal ⇒ turns=turn-1=0 (produced-nothing stall).
    expect(out.turns).toBe(0)
  })

  test("(H1.b) message_stop says tool_use but ZERO tool_use blocks → malformed recovery", async () => {
    // Stop reason says tool_use but no tool_use blocks parsed ⇒ `decideOnAssembled`
    // triggers MAX_MALFORMED_RETRIES=1 same-turn malformed nudge. After that 1
    // retry it falls through to completed without forcing a real tool dispatch.
    const malformed: StreamEvent[] = [
      { type: "text_delta", delta: "I will call a tool" },
      { type: "message_stop", stop_reason: "tool_use" }, // lies — no tool_use_start above
    ]
    const followup: StreamEvent[] = [{ type: "message_stop", stop_reason: "tool_use" }] // still lies
    const llm = new CountingLLM([malformed, followup])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const out = await withTimeout(
      runAgent({
        ...harnessBaseConfig({
          llm,
          registry,
          stream,
          permission: { mode: "bypass" },
          cwd: dir,
          maxTurns: 10,
          system: "test",
        }),
      }),
      10_000,
      "malformed-stop",
    )

    // FIX-2 (jun-25): a malformed tool_use exhausted past the retry cap seals
    // as a NON-success `error` terminal — NOT `completed`. A fumbled tool call
    // is never reported as success.
    expect(out.reason).toBe("error")
    // Exactly ONE malformed recovery (MAX_MALFORMED_RETRIES=1).
    const malformedRecov = stream.events.filter(
      (e) => e.type === "recovery" && e.reason === "malformed",
    )
    expect(malformedRecov).toHaveLength(1)
    // Stream called twice (initial + 1 same-turn retry); no tool_call ever
    // emitted because no tool_use blocks were actually parsed.
    expect(llm.calls).toBe(2)
    expect(stream.events.filter((e) => e.type === "tool_call")).toHaveLength(0)
    // The error terminal closes the loop on this turn (the `error` branch in
    // resolveTurnLoopOutcome reports `turn - 1`; no productive turn completed).
    expect(out.turns).toBe(0)
  })

  test("(H1.c) tool_use with bogus name (not in registry) → recoverable deny tool_result", async () => {
    // `dispatchTool` checks `registry.has(call.name)` first and returns a
    // recoverable deny ("Unknown tool: ...") — the model sees the deny as a
    // normal tool_result and recovers to a text completion.
    const llm = new FakeLLM([
      toolUseScript("c1", "bogus-tool-name-does-not-exist", { foo: "bar" }),
      textScript("recovered after deny"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const out = await withTimeout(
      runAgent({
        ...harnessBaseConfig({
          llm,
          registry,
          stream,
          permission: { mode: "bypass" },
          cwd: dir,
          maxTurns: 10,
          system: "test",
        }),
      }),
      10_000,
      "unknown-tool",
    )

    expect(out.reason).toBe("completed")
    // Exactly one tool_result emit, and it carries the deny content.
    const toolResults = stream.events.filter((e) => e.type === "tool_result")
    expect(toolResults).toHaveLength(1)
    const denyEv = toolResults[0]
    if (denyEv?.type === "tool_result") {
      expect(denyEv.ok).toBe(false)
      // `preview` is the dispatcher's stable short tag ("unknown tool"); the
      // human-readable error lives in the tool_result block content of the
      // assistant message in `out.messages`.
      expect(denyEv.preview).toBe("unknown tool")
    }
    // The recoverable deny content sits as a tool_result block in canonical
    // history with `is_error:true` carrying "Unknown tool: <name>".
    const errBlocks = out.messages.flatMap((m) =>
      m.content.filter(
        (b) =>
          b.type === "tool_result" &&
          b.is_error === true &&
          b.content.includes("Unknown tool: bogus-tool-name-does-not-exist"),
      ),
    )
    expect(errBlocks).toHaveLength(1)
    // Loop completed at turn 2 (tool turn + text turn).
    expect(out.turns).toBe(2)
  })
})

describe("runAgent hell-cases — adversarial tool_use", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-loop-hell-adv-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("(H2.a) tool_use with NUL bytes in arguments → tool surface accepts/rejects cleanly", async () => {
    // A path containing a NUL byte is a known-bad shape on POSIX/Node. The
    // `write` tool's Zod schema accepts the string (Zod does not reject NUL by
    // default), but the actual `fs.writeFile` call rejects with ERR_INVALID_ARG
    // and the dispatch wraps that throw into an ok:false tool_result. Pin:
    // never a process-level crash; always a recoverable tool_result block.
    const llm = new FakeLLM([
      toolUseScript("c1", "write", { path: `${dir}/has\x00nul.txt`, content: "x" }),
      textScript("recovered"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const out = await withTimeout(
      runAgent({
        ...harnessBaseConfig({
          llm,
          registry,
          stream,
          permission: { mode: "bypass" },
          cwd: dir,
          maxTurns: 10,
          system: "test",
        }),
      }),
      10_000,
      "nul-byte-args",
    )

    expect(out.reason).toBe("completed")
    // Exactly one tool_result; the dispatcher MUST NOT have thrown. The result
    // may be ok=true (NUL stripped/accepted by the filesystem) or ok=false
    // (rejected); both are acceptable but it MUST be a structured tool_result.
    const toolResults = stream.events.filter((e) => e.type === "tool_result")
    expect(toolResults).toHaveLength(1)
    // Regardless of ok/!ok, the next turn ran (proving recovery, not crash).
    expect(out.turns).toBe(2)
  })

  test("(H2.b) tool_use with 100k-char argument string → loop dispatches; output is capped", async () => {
    // Oversized content path: write 100k chars. The `write` tool succeeds
    // (filesystems handle this fine); the tool's output-spill cap may trim
    // the preview but the loop completes without OOM.
    const huge = "X".repeat(100_000)
    const file = join(dir, "huge.txt")
    const llm = new FakeLLM([
      toolUseScript("c1", "write", { path: file, content: huge }),
      textScript("oversized handled"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const out = await withTimeout(
      runAgent({
        ...harnessBaseConfig({
          llm,
          registry,
          stream,
          permission: { mode: "bypass" },
          cwd: dir,
          maxTurns: 10,
          system: "test",
        }),
      }),
      10_000,
      "huge-arg",
    )

    expect(out.reason).toBe("completed")
    // The write actually landed on disk (the bytes round-tripped).
    expect(readFileSync(file, "utf8")).toBe(huge)
    // The tool_result preview is bounded (output-spill cap). We do NOT pin a
    // specific cap (env-driven), only that the preview is a string.
    const tr = stream.events.find((e) => e.type === "tool_result")
    if (tr?.type === "tool_result") expect(typeof tr.preview).toBe("string")
    expect(out.turns).toBe(2)
  })

  test("(H2.c) tool_use with non-object input (raw string) → zod rejection wrapped in tool_result", async () => {
    // The Zod schema for `write` requires an object — a raw string input fails
    // schema validation in `ToolRegistry.run`, which throws a ToolInputError;
    // `dispatchTool.execute` catches and wraps it into an ok:false tool_result.
    const llm = new CountingLLM([
      toolUseRawInput("c1", "write", "this is a raw string not an object"),
      textScript("recovered from bad-input"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const out = await withTimeout(
      runAgent({
        ...harnessBaseConfig({
          llm,
          registry,
          stream,
          permission: { mode: "bypass" },
          cwd: dir,
          maxTurns: 10,
          system: "test",
        }),
      }),
      10_000,
      "raw-string-input",
    )

    expect(out.reason).toBe("completed")
    // Exactly one tool_result event; it's an error block carrying the zod
    // validation message.
    const tr = stream.events.filter((e) => e.type === "tool_result")
    expect(tr).toHaveLength(1)
    const ev = tr[0]
    if (ev?.type === "tool_result") {
      expect(ev.ok).toBe(false)
      expect(ev.preview).toContain("Invalid input")
    }
    expect(out.turns).toBe(2)
  })
})

describe("runAgent hell-cases — abort signal storms", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-loop-hell-abort-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("(H3.a) signal aborted EXACTLY when LLM stream starts → outcome.reason=aborted, turns=0", async () => {
    // The LLM aborts as the very first event is being emitted. `streamingTurn`
    // checks `isAborted(signal)` at every iteration boundary, so the abort is
    // caught and the loop reports turns=0 (no productive turn). CRITICAL:
    // outcome.messages is the seeded conversation (no partial assistant turn).
    const ac = new AbortController()
    const llm: LLMPort = {
      model: "abort-at-stream-start",
      async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
        ac.abort() // the instant the stream is touched
        yield { type: "text_delta", delta: "this never lands" }
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    }
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const out = await withTimeout(
      runAgent({
        ...harnessBaseConfig({
          llm,
          registry,
          stream,
          permission: { mode: "bypass" },
          cwd: dir,
          maxTurns: 5,
          system: "test",
          signal: ac.signal,
        }),
      }),
      10_000,
      "abort-at-stream-start",
    )

    expect(out.reason).toBe("aborted")
    expect(out.turns).toBe(0)
    // Done event must announce aborted.
    const done = stream.events.find((e) => e.type === "done")
    if (done?.type === "done") expect(done.reason).toBe("aborted")
    // No assistant message landed in canonical history.
    const assistantTurns = out.messages.filter((m) => m.role === "assistant")
    expect(assistantTurns).toHaveLength(0)
  })

  test("(H3.b) signal.abort() called 10x in rapid succession → idempotent, single done event", async () => {
    // `AbortController.abort()` is idempotent — calling it 10x must not produce
    // 10 done events or thrash the loop. Pin: outcome aborted, exactly one done.
    const ac = new AbortController()
    const llm: LLMPort = {
      async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
        // Trigger the storm partway through a stream.
        for (let i = 0; i < 10; i++) ac.abort()
        yield { type: "text_delta", delta: "doomed" }
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    }
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const out = await withTimeout(
      runAgent({
        ...harnessBaseConfig({
          llm,
          registry,
          stream,
          permission: { mode: "bypass" },
          cwd: dir,
          maxTurns: 5,
          system: "test",
          signal: ac.signal,
        }),
      }),
      10_000,
      "abort-storm",
    )

    expect(out.reason).toBe("aborted")
    // Single done event despite 10 abort calls.
    const doneEvents = stream.events.filter((e) => e.type === "done")
    expect(doneEvents).toHaveLength(1)
  })

  test("(H3.c) parent signal aborts mid stream (inside tool_use_delta) → aborted cleanly", async () => {
    // Abort fires DURING streaming, AFTER a tool_use_delta has flown. The
    // assembled message is dropped; tool dispatch is never reached.
    const ac = new AbortController()
    const llm: LLMPort = {
      async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
        yield { type: "tool_use_start", id: "mid-tool", name: "write" }
        yield { type: "tool_use_delta", id: "mid-tool", delta: '{"path":"' }
        ac.abort() // abort RIGHT in the middle of streaming tool_use input
        yield { type: "tool_use_delta", id: "mid-tool", delta: '/tmp/x"}' }
        yield { type: "tool_use_end", id: "mid-tool", input: { path: "/tmp/x", content: "y" } }
        yield { type: "message_stop", stop_reason: "tool_use" }
      },
    }
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const out = await withTimeout(
      runAgent({
        ...harnessBaseConfig({
          llm,
          registry,
          stream,
          permission: { mode: "bypass" },
          cwd: dir,
          maxTurns: 5,
          system: "test",
          signal: ac.signal,
        }),
      }),
      10_000,
      "abort-mid-tool-delta",
    )

    expect(out.reason).toBe("aborted")
    expect(out.turns).toBe(0)
    // NO tool_call event should have been emitted (tool dispatch was unreached
    // because `streamingTurn`'s post-stream abort check kicked in first).
    const toolCalls = stream.events.filter((e) => e.type === "tool_call")
    expect(toolCalls).toHaveLength(0)
  })
})

describe("runAgent hell-cases — resource exhaustion patterns", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-loop-hell-exhaust-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("(H4.a) 50-turn ping-pong stress → bounded by maxTurns=50, completes in <5s", async () => {
    // The model never gives up: every turn is a `write` tool_use. With
    // maxTurns:50 the loop must hit max_turns at exactly 50 streaming calls.
    const file = join(dir, "pong.txt")
    const llm = new FakeLLM([toolUseScript("c", "write", { path: file, content: "p" })])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const start = performance.now()
    const out = await withTimeout(
      runAgent({
        ...harnessBaseConfig({
          llm,
          registry,
          stream,
          permission: { mode: "bypass" },
          cwd: dir,
          maxTurns: 50,
          system: "test",
        }),
      }),
      10_000,
      "50-turn-ping-pong",
    )
    const elapsed = performance.now() - start

    expect(out.reason).toBe("max_turns")
    expect(out.turns).toBe(50)
    expect(llm.calls).toBe(50)
    // Must complete in well under the timeout — pin a lenient 5s budget so a
    // slow CI doesn't flake but a runaway regression still fails.
    expect(elapsed).toBeLessThan(5000)
  })

  test("(H4.b) single turn with 50 tool_use blocks back-to-back → all results captured in order", async () => {
    // Mass-parallel: one assistant turn emits 50 concurrency-safe `read` calls.
    // All 50 dispatch (streaming engine schedules safe calls in-flight), and
    // resultBlocks come back in exact model-call order.
    const N = 50
    const files: string[] = []
    for (let i = 0; i < N; i++) {
      const p = join(dir, `f${i}.txt`)
      writeFileSync(p, `data-${i}`)
      files.push(p)
    }
    const calls = files.map((p, i) => ({ id: `r${i}`, name: "read", input: { path: p } }))
    const llm = new FakeLLM([multiToolScript(calls), textScript("all read")])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const out = await withTimeout(
      runAgent({
        ...harnessBaseConfig({
          llm,
          registry,
          stream,
          permission: { mode: "bypass" },
          cwd: dir,
          maxTurns: 5,
          system: "test",
        }),
      }),
      10_000,
      "50-tool-blocks",
    )

    expect(out.reason).toBe("completed")
    // The user message after the assistant turn carries ALL N tool_results
    // in exact model-call order.
    const resultMsg = out.messages.find(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    )
    const ids = resultMsg?.content
      .filter((b) => b.type === "tool_result")
      .map((b) => (b.type === "tool_result" ? b.tool_use_id : ""))
    expect(ids).toEqual(calls.map((c) => c.id))
    expect(out.turns).toBe(2)
  })
})

describe("runAgent hell-cases — recovery storm", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-loop-hell-recov-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("(H5.a) malformed + empty in the same turn → both recoveries fire, then NON-success terminal (jul-3 C1)", async () => {
    // 1st stream: malformed (stop=tool_use, no tool_use blocks) ⇒ 1 malformed
    // recovery (budget=1). 2nd stream: empty content ⇒ 1 empty recovery
    // (budget=2). 3rd stream: another empty ⇒ 1 more empty recovery (budget
    // exhausted at 2). 4th stream: another empty ⇒ exhausted ⇒ NON-success
    // `error` terminal (jul-3 C1 — was `completed`).
    const malformed: StreamEvent[] = [{ type: "message_stop", stop_reason: "tool_use" }]
    const empty: StreamEvent[] = [{ type: "message_stop", stop_reason: "end_turn" }]
    const llm = new CountingLLM([malformed, empty, empty, empty])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const out = await withTimeout(
      runAgent({
        ...harnessBaseConfig({
          llm,
          registry,
          stream,
          permission: { mode: "bypass" },
          cwd: dir,
          maxTurns: 10,
          system: "test",
        }),
      }),
      10_000,
      "recovery-storm",
    )

    // TEETH: pre-fix `completed`. jul-3 (C1) — exhausted empty budget ⇒ error.
    expect(out.reason).toBe("error")
    // BOTH recovery kinds fired in the same turn — budgets are independent.
    const malformedRec = stream.events.filter(
      (e) => e.type === "recovery" && e.reason === "malformed",
    )
    const emptyRec = stream.events.filter((e) => e.type === "recovery" && e.reason === "empty")
    expect(malformedRec).toHaveLength(1)
    expect(emptyRec).toHaveLength(2) // MAX_CONSECUTIVE_EMPTIES=2 = exactly two nudges
    // Same-turn retries never consume the maxTurns slot; jul-3 (C1) the error
    // terminal resolves turns=turn-1=0 (the empty turn produced nothing).
    expect(out.turns).toBe(0)
    // Stream called exactly 4 times (initial malformed + 1 empty nudge + 2 caps).
    expect(llm.calls).toBe(4)
  })

  test("(H5.b) recovery budget exhausted by 5 consecutive empties → NON-success terminal (no infinite loop, jul-3 C1)", async () => {
    // Repeated empties past the cap MUST terminate (not max_turns), proving
    // the recovery budget is finite. Pin exact stream-call count = 3
    // (MAX_CONSECUTIVE_EMPTIES=2 + the final exhaustion call).
    const empty: StreamEvent[] = [{ type: "message_stop", stop_reason: "end_turn" }]
    const llm = new CountingLLM([empty, empty, empty, empty, empty])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const out = await withTimeout(
      runAgent({
        ...harnessBaseConfig({
          llm,
          registry,
          stream,
          permission: { mode: "bypass" },
          cwd: dir,
          maxTurns: 20,
          system: "test",
        }),
      }),
      10_000,
      "recovery-exhausted",
    )

    // Per the recovery FSM the loop terminates the exhausted empty turn rather
    // than running until max_turns. jul-3 (C1): the terminal is a NON-success
    // `error` (was `completed`) — a produced-NOTHING stall is not success.
    expect(out.reason).toBe("error")
    // jul-3 (C1): error terminal ⇒ turns=turn-1=0 (produced-nothing stall).
    expect(out.turns).toBe(0)
    // Exactly MAX_CONSECUTIVE_EMPTIES=2 nudges fire; the 3rd empty exhausts
    // and seals the NON-success error terminal.
    const emptyRec = stream.events.filter((e) => e.type === "recovery" && e.reason === "empty")
    expect(emptyRec).toHaveLength(2)
    // Stream called 3 times, NOT 5 — the extra scripts are never reached.
    expect(llm.calls).toBe(3)
  })
})
