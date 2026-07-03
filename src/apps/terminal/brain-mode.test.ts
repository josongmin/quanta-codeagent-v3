/**
 * B3 hellgate — the terminal "brain-mode" entry (`runTerminalBrain`).
 *
 * Proves the brain process REALLY drives the agent loop over the brain↔hands JSON-line stdio
 * duplex (RFC jun-29 §13, spec S2/S3 / B3). A scripted fake LLM emits ONE `container_exec` tool
 * call; a fake HANDS side reads the framed exec request off the brain's stdout and pushes back an
 * `exec_result`; the loop consumes the result, completes, and the report JSON is written through
 * the injected `writeReport`. This is a real effect (a command round-trips the duplex + a report is
 * produced) — NOT a reference: a brain that never wires `terminalSurfaceOverDuplex` / never drives
 * the loop / never writes the report goes RED here.
 *
 * Surface-isolation: this test stays INSIDE `src/apps/terminal/**`. It MUST NOT import the headless
 * surface; the minimal fake LLM is replicated locally (LLMPort over `@/llm` types only).
 */
import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { SELF_TEST_DISCIPLINE, TERMINAL_OPERATOR_GUIDE } from "@/tool"
import type {
  AttachResult,
  PtyHandle,
  PtyResult,
  PtySessionPort,
  ReadResult,
} from "@/tool/pty/port"
import {
  compactTrajectory,
  decideGateFollowup,
  ORACLE_LOOP_FEEDBACK,
  resolveMaxTurnsFromEnv,
  resolveOracleLoopRounds,
  resolveTrajectoryOn,
  runTerminalBrain,
  TB_ENV_OWNED_ENV,
  TB_ORACLE_LOOP_ENV,
  TB_OUTPUT_CONTRACT_ENV,
  TB_SELF_TEST_ENV,
  TB_VERIFY_GATE_ENV,
  TB_WRITE_TOOL_ENV,
  VERIFY_GATE_FOLLOWUP,
} from "./brain-mode"

describe("cassette trajectory (RFC 07) — default-on recording", () => {
  test("resolveTrajectoryOn: DEFAULT true; only 0/false/off disable", () => {
    expect(resolveTrajectoryOn({})).toBe(true) // default ON
    expect(resolveTrajectoryOn({ QUANTA_TB_TRAJECTORY: "1" })).toBe(true)
    expect(resolveTrajectoryOn({ QUANTA_TB_TRAJECTORY: "0" })).toBe(false)
    expect(resolveTrajectoryOn({ QUANTA_TB_TRAJECTORY: "false" })).toBe(false)
    expect(resolveTrajectoryOn({ QUANTA_TB_TRAJECTORY: "off" })).toBe(false)
  })

  test("compactTrajectory pairs each command with ok/exit/preview (the RCA record)", () => {
    const steps = compactTrajectory([
      {
        type: "tool_call",
        id: "1",
        name: "container_exec",
        input: { command: "gcc main.c -o cmain" },
      },
      { type: "tool_result", id: "1", name: "container_exec", ok: true, preview: "", exitCode: 0 },
      { type: "tool_call", id: "2", name: "container_exec", input: { command: "./cmain" } },
      {
        type: "tool_result",
        id: "2",
        name: "container_exec",
        ok: false,
        preview: "Segfault",
        exitCode: 139,
      },
    ] as never)
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({
      kind: "exec",
      cmd: "gcc main.c -o cmain",
      ok: true,
      exitCode: 0,
    })
    expect(steps[1]).toMatchObject({ kind: "exec", ok: false, exitCode: 139, preview: "Segfault" })
  })

  test("P1-E: coalesces assistant_text between tool calls into ordered kind:text steps", () => {
    const steps = compactTrajectory([
      { type: "assistant_text", delta: "Let me " },
      { type: "assistant_text", delta: "build it." },
      { type: "tool_call", id: "1", name: "container_exec", input: { command: "make" } },
      { type: "tool_result", id: "1", name: "container_exec", ok: true, preview: "", exitCode: 0 },
      { type: "assistant_text", delta: "Verified green, done." },
    ] as never)
    expect(steps).toHaveLength(3)
    expect(steps[0]).toMatchObject({ kind: "text", text: "Let me build it." }) // coalesced, before the call
    expect(steps[1]).toMatchObject({ kind: "exec", cmd: "make" })
    expect(steps[2]).toMatchObject({ kind: "text", text: "Verified green, done." }) // trailing claim captured
  })

  test("P1-E: no assistant text ⇒ steps unchanged (only tool steps)", () => {
    const steps = compactTrajectory([
      { type: "tool_call", id: "1", name: "container_exec", input: { command: "ls" } },
      { type: "tool_result", id: "1", name: "container_exec", ok: true, preview: "x", exitCode: 0 },
    ] as never)
    expect(steps).toHaveLength(1)
    expect(steps[0]?.kind).toBe("exec")
  })
})

describe("decideGateFollowup (S4, RFC jul-3) — RUN-only trigger truth table", () => {
  const D = (o: Partial<Parameters<typeof decideGateFollowup>[0]>) =>
    decideGateFollowup({
      exercised: true,
      ranClean: true,
      outputContractOn: false,
      budgetLeft: true,
      ...o,
    })

  test("S4 core: fire the RUN nudge iff the deliverable was NEVER exercised", () => {
    // extract-elf/sam fake-green: wrote the deliverable, declared done, ran it 0 times.
    expect(D({ exercised: false })).toEqual({ fire: true, nudge: "run" })
    // exercised ⇒ it ran; S4 no longer forces a "compare" (that regressed path-tracing). No fire.
    expect(D({ exercised: true })).toEqual({ fire: false, nudge: "none" })
  })

  test("S4 REGRESSION-GUARD: exercised-but-not-compared must NOT fire (kills path-tracing rework)", () => {
    // path-tracing exercised its tracer; our narrow L1 misses the image compare. The old !compared
    // nudge forced a rework that broke the refined image.c (2/3→1/3). S4 stays silent on this cell.
    expect(D({ exercised: true, ranClean: true, outputContractOn: true })).toEqual({
      fire: false,
      nudge: "none",
    })
    expect(D({ exercised: true, ranClean: true, outputContractOn: false })).toEqual({
      fire: false,
      nudge: "none",
    })
  })

  test("OC1 ON + crash/never-clean (sam-cell-seg exit 2) fires the RUN nudge even if 'exercised'", () => {
    // It attempted to run but crashed to a dirty exit — the contract's run-part is unmet → re-run.
    expect(D({ exercised: true, ranClean: false, outputContractOn: true })).toEqual({
      fire: true,
      nudge: "run",
    })
    // Same crash with OC1 OFF: ranClean is ignored, so an exercised run does NOT fire.
    expect(D({ exercised: true, ranClean: false, outputContractOn: false })).toEqual({
      fire: false,
      nudge: "none",
    })
  })

  test("never-exercised dominates regardless of OC1/ranClean", () => {
    expect(D({ exercised: false, ranClean: true, outputContractOn: true })).toEqual({
      fire: true,
      nudge: "run",
    })
  })

  test("budget exhausted ⇒ NEVER fires (no over-persist past the cap)", () => {
    expect(
      D({ exercised: false, ranClean: false, outputContractOn: true, budgetLeft: false }),
    ).toEqual({
      fire: false,
      nudge: "none",
    })
  })

  test("the OC1 knob name is the declared sub-lever env var", () => {
    expect(TB_OUTPUT_CONTRACT_ENV).toBe("QUANTA_TB_OUTPUT_CONTRACT")
  })
})

/** Local minimal `LLMPort` (headless `FakeLlm` precedent, replicated to honor the terminal fence).
 *  Replays one `StreamEvent[]` script per assistant turn, in order; a turn beyond the list replays
 *  the LAST script. `seen` is exposed so the test can assert what the loop fed the model. */
class FakeLlm implements LLMPort {
  readonly model = "terminal-fake"
  readonly provider = "terminal"
  readonly authMode = "fake"
  readonly seen: StreamInput[] = []
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  constructor(scripts: StreamEvent[][]) {
    if (scripts.length === 0) throw new Error("FakeLlm requires at least one script")
    this.scripts = scripts
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seen.push(input)
    const next = this.scripts.shift()
    if (next) this.last = next
    for (const ev of next ?? this.last) yield ev
  }
}

/** In-memory line stdin/stdout pair + a programmable HANDS side. `stdout.write` captures the brain's
 *  outbound frames; the hands loop watches them and, on an `exec` frame, pushes an `exec_result`
 *  onto `stdin` (the brain's read side). Mirrors `terminal-surface.test.ts#makeDuplex`.
 *  `codeFor` (optional) chooses the exit code per exec command (default 0) — used by the Phase C
 *  oracle-loop e2e to make a self-test go RED then GREEN on re-run (a stateful closure). */
const makeStdio = (codeFor?: (command: string) => number) => {
  const written: string[] = []
  const inBuf: string[] = []
  const resolvers: Array<(v: IteratorResult<string>) => void> = []
  let ended = false
  const pushIn = (line: string): void => {
    const r = resolvers.shift()
    if (r) r({ value: line, done: false })
    else inBuf.push(line)
  }
  const endIn = (): void => {
    ended = true
    for (const r of resolvers.splice(0)) r({ value: undefined as never, done: true })
  }
  const stdin: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<string>> => {
        const n = inBuf.shift()
        if (n !== undefined) return Promise.resolve({ value: n, done: false })
        if (ended) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((res) => resolvers.push(res))
      },
    }),
  }
  // The HANDS auto-responder: every outbound `exec` frame gets an `exec_result` pushed back.
  const handsServed: Array<Record<string, unknown>> = []
  const stdout = {
    write(line: string): void {
      written.push(line)
      const frame = JSON.parse(line) as { id: number; type: string; command?: string }
      if (frame.type === "exec") {
        handsServed.push(frame)
        pushIn(
          JSON.stringify({
            id: frame.id,
            type: "exec_result",
            stdout: `ran:${frame.command ?? ""}`,
            stderr: "",
            code: codeFor?.(frame.command ?? "") ?? 0,
          }),
        )
      }
    },
  }
  return { stdin, stdout, written, handsServed, endIn }
}

describe("QUANTA_MAX_TURNS turn-budget wiring (reuse shared knob, not a new one)", () => {
  test("resolveMaxTurnsFromEnv: unset/blank/invalid ⇒ undefined (default 30 preserved); positive ⇒ value", () => {
    expect(resolveMaxTurnsFromEnv({})).toBeUndefined() // byte-identical default
    expect(resolveMaxTurnsFromEnv({ QUANTA_MAX_TURNS: "" })).toBeUndefined()
    expect(resolveMaxTurnsFromEnv({ QUANTA_MAX_TURNS: "   " })).toBeUndefined()
    expect(resolveMaxTurnsFromEnv({ QUANTA_MAX_TURNS: "abc" })).toBeUndefined()
    expect(resolveMaxTurnsFromEnv({ QUANTA_MAX_TURNS: "0" })).toBeUndefined()
    expect(resolveMaxTurnsFromEnv({ QUANTA_MAX_TURNS: "-5" })).toBeUndefined()
    expect(resolveMaxTurnsFromEnv({ QUANTA_MAX_TURNS: "60" })).toBe(60)
    expect(resolveMaxTurnsFromEnv({ QUANTA_MAX_TURNS: "12.9" })).toBe(12)
  })

  // NB: the loop-CAP behavior (opts.maxTurns → buildTerminalRuntime.maxTurns → runSessionTurn) is
  // pre-existing core wiring; a perpetual-tool-call cap test here triggers end-of-run memory
  // consolidation that pollutes a module singleton and breaks sibling tests, so the cap is left to
  // the core's own coverage. What is NEW and tested above is the env→opts parse (resolveMaxTurnsFromEnv);
  // main() threads it verbatim: `...(maxTurns !== undefined ? { maxTurns } : {})`.
})

/** A single `container_exec` tool-call turn, then a text completion turn. */
const execThenDoneScripts = (command: string): StreamEvent[][] => [
  [
    { type: "tool_use_start", id: "call-1", name: "container_exec" },
    { type: "tool_use_end", id: "call-1", input: { command } },
    { type: "usage", inputTokens: 11, outputTokens: 7, model: "terminal-fake" },
    { type: "message_stop", stop_reason: "tool_use" },
  ],
  [
    { type: "text_delta", delta: "done" },
    { type: "usage", inputTokens: 5, outputTokens: 3, model: "terminal-fake" },
    { type: "message_stop", stop_reason: "end_turn" },
  ],
]

describe("terminal brain-mode (B3) — drives the loop over the brain↔hands duplex", () => {
  test("emits a well-formed exec frame, consumes exec_result, and writes the report", async () => {
    const { stdin, stdout, written, handsServed, endIn } = makeStdio()
    const reports: Array<{ path: string; obj: unknown }> = []

    const result = await runTerminalBrain({
      instruction: "say hi inside the container",
      model: "terminal-fake",
      reportOut: "/tmp/brain-report.json",
      stdin,
      stdout,
      llm: new FakeLlm(execThenDoneScripts("echo hi")),
      writeReport: (path, obj) => {
        reports.push({ path, obj })
      },
    })

    // (a) the brain framed a real, well-formed exec request onto stdout (protocol frame only).
    const execFrames = written.map((l) => JSON.parse(l)).filter((f) => f.type === "exec")
    expect(execFrames.length).toBe(1)
    expect(execFrames[0]).toMatchObject({ type: "exec", command: "echo hi" })
    expect(typeof execFrames[0].id).toBe("number")
    // every stdout line is a protocol frame (reserved channel) — no stray log text leaked.
    for (const line of written) expect(() => JSON.parse(line)).not.toThrow()

    // (b) the HANDS side actually served the request and the loop consumed the exec_result and
    //     completed (≥2 turns: the tool call turn + the completion turn).
    expect(handsServed.length).toBe(1)
    expect(result.turns).toBeGreaterThanOrEqual(1)
    expect(result.report.final).toBe("done")

    // (c) the report was written to the requested path with the right shape (turns, tokens).
    expect(reports.length).toBe(1)
    expect(reports[0]?.path).toBe("/tmp/brain-report.json")
    const report = reports[0]?.obj as {
      instruction: string
      turns: number
      tokens: { input: number; output: number }
      cost_usd: number
      final: string
    }
    expect(report.instruction).toBe("say hi inside the container")
    expect(report.turns).toBeGreaterThanOrEqual(1)
    expect(report.tokens.input).toBeGreaterThan(0)
    expect(report.tokens.output).toBeGreaterThan(0)
    expect(typeof report.cost_usd).toBe("number")
    expect(report.final).toBe("done")

    endIn()
  })

  test("the operator guide + the terminal tool surface actually reach the model", async () => {
    const { stdin, stdout, endIn } = makeStdio()
    const llm = new FakeLlm(execThenDoneScripts("echo hi"))
    await runTerminalBrain({
      instruction: "do the task",
      reportOut: "/tmp/brain-report-guide.json",
      stdin,
      stdout,
      llm,
      writeReport: () => undefined,
    })
    // The loop fed the model at least the first turn; assert on what it saw.
    const first = llm.seen[0]
    if (!first) throw new Error("the loop must have streamed at least one turn to the model")
    // (1) the operator capability guide rode into the prompt (the instruction turn). Concatenate the
    //     raw text blocks of the user messages (no JSON stringify — that would escape newlines and
    //     defeat a substring match across the guide's line breaks). A brain that drops the guide goes
    //     RED here; the assertion is the FULL guide body, not just its first line.
    const userText = first.messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content)
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
    expect(userText).toContain(TERMINAL_OPERATOR_GUIDE)
    // (2) the BASE-free terminal tool surface was offered to the model: container_exec is present,
    //     and NONE of the BASE repo-edit/host-exec tools leaked (spec S2/S3).
    const offered = first.tools.map((t) => t.name)
    expect(offered).toContain("container_exec")
    for (const base of ["read", "write", "edit", "apply_patch", "bash", "grep", "ls"]) {
      expect(offered).not.toContain(base)
    }
    endIn()
  })

  describe("S1 self-test discipline (QUANTA_TB_SELF_TEST) — wiring", () => {
    const firstUserText = (llm: FakeLlm): string => {
      const first = llm.seen[0]
      if (!first) throw new Error("the loop must have streamed at least one turn to the model")
      return first.messages
        .filter((m) => m.role === "user")
        .flatMap((m) => m.content)
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n")
    }

    test("knob ON ⇒ the FULL self-test discipline body reaches the model (after the operator guide)", async () => {
      const { stdin, stdout, endIn } = makeStdio()
      const llm = new FakeLlm(execThenDoneScripts("echo hi"))
      await runTerminalBrain({
        instruction: "write fib(n)",
        reportOut: "/tmp/brain-selftest-on.json",
        stdin,
        stdout,
        llm,
        writeReport: () => undefined,
        env: { [TB_SELF_TEST_ENV]: "1" },
      })
      const text = firstUserText(llm)
      // The FULL body (not just a header) rode into the instruction turn — a drop goes RED here.
      expect(text).toContain(SELF_TEST_DISCIPLINE)
      // It rides AFTER the operator guide and BEFORE the task, on the same turn.
      expect(text).toContain(TERMINAL_OPERATOR_GUIDE)
      expect(text.indexOf(TERMINAL_OPERATOR_GUIDE)).toBeLessThan(text.indexOf(SELF_TEST_DISCIPLINE))
      expect(text.indexOf(SELF_TEST_DISCIPLINE)).toBeLessThan(text.indexOf("write fib(n)"))
      endIn()
    })

    test("knob OFF (default) ⇒ the instruction turn is byte-identical: NO discipline block", async () => {
      const { stdin, stdout, endIn } = makeStdio()
      const llm = new FakeLlm(execThenDoneScripts("echo hi"))
      await runTerminalBrain({
        instruction: "write fib(n)",
        reportOut: "/tmp/brain-selftest-off.json",
        stdin,
        stdout,
        llm,
        writeReport: () => undefined,
      })
      const text = firstUserText(llm)
      expect(text).not.toContain(SELF_TEST_DISCIPLINE)
      // The frozen turn shape is preserved: guide, blank line, then the task header — nothing spliced.
      expect(text).toContain(`${TERMINAL_OPERATOR_GUIDE}\n\n# Task\nwrite fib(n)`)
      endIn()
    })

    test("no-leak: the discipline names no hidden-oracle terms (can never teach peeking)", () => {
      const lower = SELF_TEST_DISCIPLINE.toLowerCase()
      // It may say "test" (it tells the agent to build ITS OWN self-test) but must forbid the hidden ones.
      expect(lower).toContain("do not read, import, or run any provided test/verifier/answer files")
      for (const w of ["golden", "answer key", "grader file", "hidden test"]) {
        expect(lower).not.toContain(w)
      }
    })

    test("S1b receipt: knob ON ⇒ report.selfTest is emitted (OBSERVE-ONLY measurement rides the lever)", async () => {
      const { stdin, stdout, endIn } = makeStdio()
      const llm = new FakeLlm(execThenDoneScripts("python test_fib.py"))
      const result = await runTerminalBrain({
        instruction: "write fib(n)",
        reportOut: "/tmp/brain-selftest-receipt-on.json",
        stdin,
        stdout,
        llm,
        writeReport: () => undefined,
        env: { [TB_SELF_TEST_ENV]: "1" },
      })
      // The receipt is present and observed the authored self-test the fake run executed.
      expect(result.report.selfTest).toBeDefined()
      expect(result.report.selfTest?.executed).toBe(true)
      endIn()
    })

    test("S1b receipt: knob OFF (default) ⇒ report.selfTest is ABSENT (byte-identical)", async () => {
      const { stdin, stdout, endIn } = makeStdio()
      const llm = new FakeLlm(execThenDoneScripts("python test_fib.py"))
      const result = await runTerminalBrain({
        instruction: "write fib(n)",
        reportOut: "/tmp/brain-selftest-receipt-off.json",
        stdin,
        stdout,
        llm,
        writeReport: () => undefined,
      })
      expect(result.report.selfTest).toBeUndefined()
      endIn()
    })
  })

  test("report is written BEFORE EOF is signaled (spec B3 ordering: report, then close)", async () => {
    const { stdin, stdout } = makeStdio()
    // A monotonic event log so we can assert the strict happens-before of write → close. A brain
    // that closes stdout before persisting the report races the hands side reading a stale/missing
    // report file — this ordering assertion is the regression fence for that bug.
    const order: string[] = []
    await runTerminalBrain({
      instruction: "noop",
      reportOut: "/tmp/brain-report-2.json",
      stdin,
      stdout,
      llm: new FakeLlm([
        [
          { type: "text_delta", delta: "ok" },
          { type: "message_stop", stop_reason: "end_turn" },
        ],
      ]),
      writeReport: () => order.push("write-report"),
      closeStdout: () => order.push("close-stdout"),
    })
    expect(order).toEqual(["write-report", "close-stdout"])
  })

  test("a mid-run LLM failure STILL writes a report + closes stdout in order (no hang)", async () => {
    const { stdin, stdout } = makeStdio()
    const order: string[] = []
    // A fake LLM that throws on its first stream — simulates the model dying mid-run. The agent loop
    // is resilient and folds the failure into an error OUTCOME rather than throwing past the surface,
    // so the brain MUST still emit a report and close the channel (the hands side never hangs). This
    // exercises the SAME write→close ordering on the failure path.
    const throwingLlm: LLMPort = {
      model: "boom",
      provider: "terminal",
      authMode: "fake",
      // biome-ignore lint/correctness/useYield: intentionally throws before yielding any event.
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error("brain exploded")
      },
    }
    let written: TerminalBrainReportShape | undefined
    const result = await runTerminalBrain({
      instruction: "will fail",
      reportOut: "/tmp/brain-report-3.json",
      stdin,
      stdout,
      llm: throwingLlm,
      writeReport: (_path, obj) => {
        order.push("write-report")
        written = obj as unknown as TerminalBrainReportShape
      },
      closeStdout: () => order.push("close-stdout"),
    })
    // Report written, THEN EOF — even when the model blew up.
    expect(order).toEqual(["write-report", "close-stdout"])
    expect(written?.instruction).toBe("will fail")
    // A report is always produced (shape intact) so the hands side has something to read.
    expect(result.report.instruction).toBe("will fail")
    expect(typeof result.report.cost_usd).toBe("number")
  })
})

type TerminalBrainReportShape = {
  instruction: string
  turns: number
  tokens: { input: number; output: number }
  cost_usd: number
  final: string
  verification?: { state: string; evidence: string }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Lever #1 — environment posture (RFC jul-2-terminal-bench-levers/01).
// HELLGATE: RED-first (the brain's SYSTEM prompt TODAY carries the frozen [R-ENV] guardrail), then
// knob-ON behavior (owned posture: [R-ENV] / [R-STOP-ENV] gone, [R-ENV-OWNED] present) and the
// DEFAULT-OFF byte-identical proof (unset ≡ explicit-off ≡ pre-lever system prompt).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The SYSTEM prompt the loop fed the model on the FIRST turn, as a plain string (the `system`
 *  channel is a string OR an ordered block list — flatten both to text for a substring match). */
const firstSystemText = (llm: FakeLlm): string => {
  const first = llm.seen[0]
  if (!first) throw new Error("the loop must have streamed at least one turn to the model")
  const sys = first.system
  if (sys === undefined) return ""
  if (typeof sys === "string") return sys
  return sys.map((b) => b.text).join("\n")
}

/** Run the brain once and return the captured FakeLlm (for `firstSystemText`). */
const runAndCaptureSystem = async (env?: Record<string, string>): Promise<FakeLlm> => {
  const { stdin, stdout, endIn } = makeStdio()
  const llm = new FakeLlm(execThenDoneScripts("echo hi"))
  await runTerminalBrain({
    instruction: "do the task",
    reportOut: "/tmp/brain-envposture.json",
    stdin,
    stdout,
    llm,
    writeReport: () => undefined,
    ...(env !== undefined ? { env } : {}),
  })
  endIn()
  return llm
}

describe("environment posture (lever #1)", () => {
  test("RED baseline (knob OFF, today): the brain SYSTEM prompt carries the frozen [R-ENV] guardrail", async () => {
    const llm = await runAndCaptureSystem()
    const system = firstSystemText(llm)
    // The frozen install-prohibition rules are in the SYSTEM prompt (not the user turn).
    expect(system).toContain("[R-ENV]")
    expect(system).toContain("[R-STOP-ENV]")
    // And the owned rule is NOT present when the knob is off.
    expect(system).not.toContain("[R-ENV-OWNED]")
  })

  test("knob ON: the brain SYSTEM prompt swaps to the owned posture (no [R-ENV]/[R-STOP-ENV], has [R-ENV-OWNED])", async () => {
    const llm = await runAndCaptureSystem({ [TB_ENV_OWNED_ENV]: "1" })
    const system = firstSystemText(llm)
    expect(system).not.toContain("[R-ENV]")
    expect(system).not.toContain("[R-STOP-ENV]")
    expect(system).toContain("[R-ENV-OWNED]")
    expect(system).toContain("[R-INSTALL-THRASH]")
    // The universal honesty rails survive the swap (posture drops ONLY env rules).
    expect(system).toContain("[R-READ-FAILURE]")
    expect(system).toContain("[R-FAILURE-MODE]")
  })

  test("DEFAULT-OFF byte-identical: the brain SYSTEM prompt is IDENTICAL unset vs explicit-off", async () => {
    const unset = firstSystemText(await runAndCaptureSystem(undefined))
    const explicitOff = firstSystemText(await runAndCaptureSystem({ [TB_ENV_OWNED_ENV]: "0" }))
    expect(explicitOff).toBe(unset)
    // And the off prompt is the frozen one (carries [R-ENV]).
    expect(unset).toContain("[R-ENV]")
  })

  test("posture is PROMPT-TEXT-ONLY: knob ON does NOT change the offered tools or the permission mode", async () => {
    // Same tool surface + no host-exec leak whether frozen or owned — the posture never touches
    // runtime enforcement, only the rendered system-prompt rule text.
    const frozen = await runAndCaptureSystem(undefined)
    const owned = await runAndCaptureSystem({ [TB_ENV_OWNED_ENV]: "1" })
    const toolsOf = (llm: FakeLlm) => (llm.seen[0]?.tools ?? []).map((t) => t.name).sort()
    expect(toolsOf(owned)).toEqual(toolsOf(frozen))
    // BASE host tools never leak under either posture.
    for (const base of ["read", "write", "edit", "apply_patch", "bash", "grep", "ls"]) {
      expect(toolsOf(owned)).not.toContain(base)
    }
    // container_exec is offered under both.
    expect(toolsOf(owned)).toContain("container_exec")
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B2 — `container_write_file` knob (RFC jul-3, default-OFF). The gate is READ in runTerminalBrain
// (env-threaded entry) and applied in the surface builder — this pins the whole wire at the
// model-visible seam (the OFFERED tool list), the inert-prevention lesson (jun-27): a knob whose
// read site drifts from the mint site silently dies.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("B2 — container_write_file knob (default-OFF)", () => {
  const toolsOf = (llm: FakeLlm) => (llm.seen[0]?.tools ?? []).map((t) => t.name)

  test("OFF (unset) ⇒ NOT offered — byte-identical tool menu", async () => {
    const llm = await runAndCaptureSystem()
    expect(toolsOf(llm)).not.toContain("container_write_file")
    expect(toolsOf(llm)).toContain("container_exec")
  })

  test("ON ⇒ offered alongside container_exec; BASE repo-edit/host tools still never leak", async () => {
    const llm = await runAndCaptureSystem({ [TB_WRITE_TOOL_ENV]: "1" })
    const names = toolsOf(llm)
    expect(names).toContain("container_write_file")
    expect(names).toContain("container_exec")
    for (const base of ["bash", "write", "edit", "apply_patch", "grep"]) {
      expect(names).not.toContain(base)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Lever #2 — verify-before-finalize gate (RFC jul-2-terminal-bench-levers/02).
// HELLGATE: RED-first (knob OFF today = no verification field, no extra turn), then knob-ON
// behaviors (one bounded follow-up, honest trichotomy), boundedness (≤1 turn, cannot loop), and
// the exercise recognizer for BOTH tools (container_exec + pty_*).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A fake `PtySessionPort` so the `pty_*` tools are minted and emit real tool_result events with
 *  observed output — lets a scripted pty exercise reach the inspector. */
const makeFakePty = (): PtySessionPort => ({
  list: async () => [],
  attach: async (handle: PtyHandle): Promise<PtyResult<AttachResult>> => ({
    ok: true,
    value: { handle, cursor: 0 },
  }),
  write: async (): Promise<PtyResult<void>> => ({ ok: true, value: undefined }),
  read: async (): Promise<PtyResult<ReadResult>> => ({
    ok: true,
    value: { chunks: [{ seq: 1, data: "4\n" }], nextSeq: 2 },
  }),
  resize: async (): Promise<PtyResult<void>> => ({ ok: true, value: undefined }),
  detach: async (): Promise<PtyResult<void>> => ({ ok: true, value: undefined }),
  kill: async (): Promise<PtyResult<void>> => ({ ok: true, value: undefined }),
})

/** One `container_exec` tool call turn (with `command`), then a text completion turn (`final`). */
const execThenFinalScripts = (command: string, finalText: string): StreamEvent[][] => [
  [
    { type: "tool_use_start", id: "call-1", name: "container_exec" },
    { type: "tool_use_end", id: "call-1", input: { command } },
    { type: "usage", inputTokens: 9, outputTokens: 4, model: "terminal-fake" },
    { type: "message_stop", stop_reason: "tool_use" },
  ],
  [
    { type: "text_delta", delta: finalText },
    { type: "usage", inputTokens: 3, outputTokens: 2, model: "terminal-fake" },
    { type: "message_stop", stop_reason: "end_turn" },
  ],
]

/** A pty exercise turn set: attach a pane, TYPE `data` (a command), READ back its response, then a
 *  text-completion turn (`final`). Uses the `pty_*` tool surface (via {@link makeFakePty}) — the ONE
 *  terminal tool path that round-trips fully in the fake harness, so v2 GATE wiring can be exercised
 *  end-to-end here regardless of the container_exec duplex. `data` is what the inspector judges:
 *  a `diff …`/`cmp …` TYPED into the pane is an L1 comparison; a bare `./run` is L0-only. */
const ptyTypeThenFinalScripts = (data: string, finalText: string): StreamEvent[][] => [
  [
    { type: "tool_use_start", id: "a1", name: "pty_attach" },
    { type: "tool_use_end", id: "a1", input: { handle: "pty:1" } },
    { type: "message_stop", stop_reason: "tool_use" },
  ],
  [
    { type: "tool_use_start", id: "w1", name: "pty_write" },
    { type: "tool_use_end", id: "w1", input: { handle: "pty:1", data, appendNewline: true } },
    { type: "message_stop", stop_reason: "tool_use" },
  ],
  [
    { type: "tool_use_start", id: "r1", name: "pty_read" },
    { type: "tool_use_end", id: "r1", input: { handle: "pty:1", sinceSeq: 0 } },
    { type: "usage", inputTokens: 4, outputTokens: 2, model: "terminal-fake" },
    { type: "message_stop", stop_reason: "tool_use" },
  ],
  [
    { type: "text_delta", delta: finalText },
    { type: "usage", inputTokens: 3, outputTokens: 2, model: "terminal-fake" },
    { type: "message_stop", stop_reason: "end_turn" },
  ],
]

describe("verify-before-finalize gate (lever #2)", () => {
  test("RED (knob OFF, today): an artifact-only run finalizes with NO verification field + NO extra turn", async () => {
    const { stdin, stdout, handsServed, endIn } = makeStdio()
    // Trajectory only CREATES an artifact (mkdir) — never runs+observes the deliverable.
    const llm = new FakeLlm(
      execThenFinalScripts("mkdir -p build", "Implemented and verified green."),
    )
    const result = await runTerminalBrain({
      instruction: "build the solver",
      reportOut: "/tmp/vg-off.json",
      stdin,
      stdout,
      llm,
      writeReport: () => undefined,
      // env omitted ⇒ gate default-OFF.
    })
    // No verification stamp, and exactly ONE served exec (the mkdir) — no gate follow-up turn.
    expect(result.report.verification).toBeUndefined()
    expect(handsServed.length).toBe(1)
    // The follow-up prompt was NEVER shown to the model (the gate did not run at all).
    const sawFollowUp = llm.seen.some((s) =>
      s.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "text" && b.text.includes(VERIFY_GATE_FOLLOWUP)),
      ),
    )
    expect(sawFollowUp).toBe(false)
    endIn()
  })

  test("knob ON + artifact-only run ⇒ exactly ONE follow-up turn, and an honest verification stamp", async () => {
    const { stdin, stdout, handsServed, endIn } = makeStdio()
    // First turn: mkdir (no exercise). Follow-up turn: model STILL only says 'done' (scripts run
    // out → the FakeLlm replays its last text-completion script) → no exercise emerges → unverifiable.
    const llm = new FakeLlm(execThenFinalScripts("mkdir -p build", "done, looks good"))
    const result = await runTerminalBrain({
      instruction: "build the solver",
      reportOut: "/tmp/vg-on.json",
      stdin,
      stdout,
      llm,
      writeReport: () => undefined,
      env: { [TB_VERIFY_GATE_ENV]: "1" },
    })
    // The gate injected the bounded follow-up: the model saw the follow-up prompt on a LATER turn.
    const sawFollowUp = llm.seen.some((s) =>
      s.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "text" && b.text.includes(VERIFY_GATE_FOLLOWUP)),
      ),
    )
    expect(sawFollowUp).toBe(true)
    // Still no exercise after the single follow-up ⇒ honest terminal state (never loops).
    expect(result.report.verification).toBeDefined()
    expect(result.report.verification?.state).toBe("unverifiable")
    // The follow-up prompt references only the task's own criterion — never a hidden test.
    expect(VERIFY_GATE_FOLLOWUP.toLowerCase()).not.toContain("test")
    expect(VERIFY_GATE_FOLLOWUP.toLowerCase()).not.toContain("hidden")
    // handsServed = mkdir (turn 1). The follow-up turn produced only text (no new exec).
    expect(handsServed.length).toBe(1)
    endIn()
  })

  // NB: the following four tests drive the pty_* tool path (via ptyTypeThenFinalScripts +
  // makeFakePty) — the ONE terminal-tool round-trip that works end-to-end in the fake harness on
  // this base (the container_exec duplex is broken by a concurrent memory-consolidation change; see
  // the 9 pre-existing failures noted in the dispatch). The v2 L1/no-leak DETECTION over BOTH tools
  // is exhaustively pinned as pure units in verify-gate.test.ts; here we prove the GATE WIRING
  // (fire-on-missing-L1, trichotomy, verified-pass-requires-L1) end-to-end.

  test("v2: knob ON + a run that COMPARED to a reference (pty diff, observed) ⇒ NO follow-up, verified-pass", async () => {
    const { stdin, stdout, endIn } = makeStdio()
    // The v2 happy path: the model DIFFED its output against a task-provided baseline (observed).
    const llm = new FakeLlm(
      ptyTypeThenFinalScripts(
        "diff mine.out /app/baseline.out",
        "No diff; matches the baseline. Pass.",
      ),
    )
    const result = await runTerminalBrain({
      instruction: "run the solver and check it",
      reportOut: "/tmp/vg-compared.json",
      stdin,
      stdout,
      llm,
      ptySession: makeFakePty(),
      writeReport: () => undefined,
      env: { [TB_VERIFY_GATE_ENV]: "1" },
    })
    // No follow-up prompt was injected (an observed L1 comparison was already present).
    const sawFollowUp = llm.seen.some((s) =>
      s.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "text" && b.text.includes(VERIFY_GATE_FOLLOWUP)),
      ),
    )
    expect(sawFollowUp).toBe(false)
    expect(result.report.verification?.state).toBe("verified-pass")
    endIn()
  })

  test("S4 REGRESSION-GUARD: a run that RAN but NEVER compared ⇒ NO nudge (kills rework), still not verified-pass", async () => {
    const { stdin, stdout, endIn } = makeStdio()
    // path-tracing class: `./solver` was EXERCISED. The old v2 nudge fired here ("go compare") and
    // reworked the already-working deliverable (2/3→1/3). Under S4 the nudge STAYS SILENT on an
    // exercised run — but the STAMP is independent: with no L1 compare it is still `unverifiable`,
    // never a false `verified-pass`. So: no nag, no rework, and no rubber-stamp either.
    const llm = new FakeLlm(
      ptyTypeThenFinalScripts("./solver input.txt", "Output looks correct. Verified green."),
    )
    const result = await runTerminalBrain({
      instruction: "run the solver",
      reportOut: "/tmp/vg-ran-not-compared.json",
      stdin,
      stdout,
      llm,
      ptySession: makeFakePty(),
      writeReport: () => undefined,
      env: { [TB_VERIFY_GATE_ENV]: "1" },
    })
    const sawFollowUp = llm.seen.some((s) =>
      s.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "text" && b.text.includes(VERIFY_GATE_FOLLOWUP)),
      ),
    )
    // S4 core regression guard: an EXERCISED run is never nagged (this is what fixes path-tracing).
    expect(sawFollowUp).toBe(false)
    // …yet the stamp still refuses to rubber-stamp an uncompared run as green.
    expect(result.report.verification?.state).not.toBe("verified-pass")
    expect(result.report.verification?.state).toBe("unverifiable")
    endIn()
  })

  test("v2 P0b OUTCOME-CORRELATION backstop: an exercised-but-WRONG-output run must NOT be verified-pass", async () => {
    const { stdin, stdout, endIn } = makeStdio()
    // The backstop the v1 unit suite LACKED (why the rubber-stamp passed CI): the deliverable RAN
    // and the agent even DIFFED it — but the diff showed a MISMATCH and the agent SAYS so. The
    // verdict must correlate with the OUTCOME (verified-FAIL), never a `verified-pass`.
    const llm = new FakeLlm(
      ptyTypeThenFinalScripts(
        "diff mine.out /app/baseline.out",
        "The output differs from the baseline; the results do not match.",
      ),
    )
    const result = await runTerminalBrain({
      instruction: "produce the answer",
      reportOut: "/tmp/vg-wrong.json",
      stdin,
      stdout,
      llm,
      ptySession: makeFakePty(),
      writeReport: () => undefined,
      env: { [TB_VERIFY_GATE_ENV]: "1" },
    })
    // Compared (L1 present) but the observed outcome was a mismatch ⇒ honest verified-fail.
    expect(result.report.verification?.state).toBe("verified-fail")
    expect(result.report.verification?.state).not.toBe("verified-pass")
    endIn()
  })

  test("S4 no-leak: a diff-against-TEST-PATH golden ⇒ leak refused at the STAMP (unverifiable), never verified-pass", async () => {
    const { stdin, stdout, endIn } = makeStdio()
    // query-optimize's golden lives in /tests/. `diff` IS an acceptance-runner (it ran + observed) so
    // S4 treats the run as EXERCISED → no nudge. But under S4 the leak refusal lives entirely in the
    // STAMP: comparedToReference rejects the /tests/ golden as an unfair reference (not L1) → the
    // verdict is `unverifiable`, NEVER a false `verified-pass`. The gate can still never TEACH peeking.
    const llm = new FakeLlm(
      ptyTypeThenFinalScripts(
        "diff out.sql /app/tests/golden.sql",
        "Matches the golden. Verified.",
      ),
    )
    const result = await runTerminalBrain({
      instruction: "optimize the query",
      reportOut: "/tmp/vg-leak.json",
      stdin,
      stdout,
      llm,
      ptySession: makeFakePty(),
      writeReport: () => undefined,
      env: { [TB_VERIFY_GATE_ENV]: "1" },
    })
    // The critical no-leak invariant: peeking at the /tests/ golden is NOT a fair compare → not green.
    expect(result.report.verification?.state).not.toBe("verified-pass")
    // And the RUN nudge, wherever it fires, names no hidden-oracle terms (pinned at the source).
    for (const w of ["test", "verifier", "grader", "hidden", "answer key"]) {
      expect(VERIFY_GATE_FOLLOWUP.toLowerCase()).not.toContain(w)
    }
    endIn()
  })

  test("v2: knob ON + a pty_* COMPARISON (diff typed + observed) ⇒ NO follow-up, verified-pass", async () => {
    const { stdin, stdout, endIn } = makeStdio()
    // v2 contract for the pty path: a bare run (`python game.py`) is L0 and no longer suffices — the
    // pty_write must TYPE an actual COMPARISON (a diff of output vs a task reference) and a pty_read
    // must observe its result for the gate to reach verified-pass.
    const scripts: StreamEvent[][] = [
      [
        { type: "tool_use_start", id: "a1", name: "pty_attach" },
        { type: "tool_use_end", id: "a1", input: { handle: "pty:1" } },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
      [
        { type: "tool_use_start", id: "w1", name: "pty_write" },
        {
          type: "tool_use_end",
          id: "w1",
          input: { handle: "pty:1", data: "diff mine.out /app/baseline.out", appendNewline: true },
        },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
      [
        { type: "tool_use_start", id: "r1", name: "pty_read" },
        { type: "tool_use_end", id: "r1", input: { handle: "pty:1", sinceSeq: 0 } },
        { type: "usage", inputTokens: 4, outputTokens: 2, model: "terminal-fake" },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "No diff output; matches the baseline. Verified." },
        { type: "message_stop", stop_reason: "end_turn" },
      ],
    ]
    const llm = new FakeLlm(scripts)
    const result = await runTerminalBrain({
      instruction: "drive the repl",
      reportOut: "/tmp/vg-pty.json",
      stdin,
      stdout,
      llm,
      ptySession: makeFakePty(),
      writeReport: () => undefined,
      env: { [TB_VERIFY_GATE_ENV]: "1" },
    })
    const sawFollowUp = llm.seen.some((s) =>
      s.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "text" && b.text.includes(VERIFY_GATE_FOLLOWUP)),
      ),
    )
    expect(sawFollowUp).toBe(false)
    expect(result.report.verification?.state).toBe("verified-pass")
    endIn()
  })

  test("BOUNDEDNESS: the gate adds AT MOST ONE turn and cannot loop even if the follow-up still shows no exercise", async () => {
    const { stdin, stdout, endIn } = makeStdio()
    // Every turn: the model ONLY emits text (never a tool call) — so no exercise EVER appears. The
    // gate must still fire the follow-up exactly ONCE and finalize `unverifiable`, never re-asking.
    const textOnly: StreamEvent[][] = [
      [
        { type: "text_delta", delta: "I created the file. Done." },
        { type: "usage", inputTokens: 3, outputTokens: 2, model: "terminal-fake" },
        { type: "message_stop", stop_reason: "end_turn" },
      ],
    ]
    const llm = new FakeLlm(textOnly)
    const result = await runTerminalBrain({
      instruction: "noop task",
      reportOut: "/tmp/vg-bounded.json",
      stdin,
      stdout,
      llm,
      writeReport: () => undefined,
      env: { [TB_VERIFY_GATE_ENV]: "1" },
    })
    // Count how many times the follow-up prompt was fed to the model: EXACTLY ONE (never a loop).
    const followUpCount = llm.seen.filter((s) =>
      s.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "text" && b.text.includes(VERIFY_GATE_FOLLOWUP)),
      ),
    ).length
    expect(followUpCount).toBe(1)
    expect(result.report.verification?.state).toBe("unverifiable")
    endIn()
  })

  test("BOUNDEDNESS (fault path): if the ONE follow-up turn itself throws, the run finalizes (report written) and still does not loop", async () => {
    const { stdin, stdout } = makeStdio()
    // First turn: a mkdir (no exercise) so the gate WILL inject the follow-up. The follow-up turn
    // is the SECOND stream — make it throw. The agent loop folds a mid-turn throw into an error
    // outcome, so the brain must still write a report exactly once (no hang, no re-ask loop).
    let streamCount = 0
    const throwOnFollowUp: LLMPort = {
      model: "terminal-fake",
      provider: "terminal",
      authMode: "fake",
      async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
        streamCount += 1
        if (streamCount === 1) {
          // turn 1: emit a mkdir tool call then finish
          yield { type: "tool_use_start", id: "c1", name: "container_exec" }
          yield { type: "tool_use_end", id: "c1", input: { command: "mkdir build" } }
          yield { type: "message_stop", stop_reason: "tool_use" }
          return
        }
        if (streamCount === 2) {
          yield { type: "text_delta", delta: "created" }
          yield { type: "message_stop", stop_reason: "end_turn" }
          return
        }
        // Any turn from the follow-up onward throws (the model died). Reference `input` so the
        // signature is honored.
        void input
        throw new Error("model died during follow-up")
      },
    }
    const reports: unknown[] = []
    const result = await runTerminalBrain({
      instruction: "will throw on follow-up",
      reportOut: "/tmp/vg-throw.json",
      stdin,
      stdout,
      llm: throwOnFollowUp,
      writeReport: (_p, obj) => reports.push(obj),
      env: { [TB_VERIFY_GATE_ENV]: "1" },
    })
    // The report was still written exactly once (the surface contract survives a follow-up throw).
    expect(reports.length).toBe(1)
    expect(result.report.instruction).toBe("will throw on follow-up")
    // The loop opened at most 3 streams: turn1 + turn1-completion + the SINGLE follow-up (which
    // threw). It did NOT re-ask (no 4th+ stream) — the gate is a one-shot, not a loop.
    expect(streamCount).toBeLessThanOrEqual(3)
  })

  test("DEFAULT-OFF byte-identical: the report is identical with the knob unset vs explicitly falsy (no verification field either way)", async () => {
    const run = async (env?: Record<string, string>) => {
      const { stdin, stdout, endIn } = makeStdio()
      const r = await runTerminalBrain({
        instruction: "same task",
        reportOut: "/tmp/vg-ident.json",
        stdin,
        stdout,
        llm: new FakeLlm(execThenFinalScripts("mkdir build", "done")),
        writeReport: () => undefined,
        ...(env !== undefined ? { env } : {}),
      })
      endIn()
      return r.report
    }
    const unset = await run(undefined)
    const explicitOff = await run({ [TB_VERIFY_GATE_ENV]: "0" })
    expect(unset.verification).toBeUndefined()
    expect(explicitOff.verification).toBeUndefined()
    // Full report equality (turns / tokens / final / instruction) — the gate changed nothing.
    expect(explicitOff).toEqual(unset)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Phase C — HARNESS-enforced oracle-repair loop (RFC jul-3 /02). The structural convergence attack:
// the harness (not a prompt line) drives the agent's OWN self-test to green with bounded feedback.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("resolveOracleLoopRounds (Phase C) — bounded round budget", () => {
  test("unset/blank/off/0 ⇒ 0 (loop off, byte-identical)", () => {
    expect(resolveOracleLoopRounds({})).toBe(0)
    expect(resolveOracleLoopRounds({ [TB_ORACLE_LOOP_ENV]: "" })).toBe(0)
    expect(resolveOracleLoopRounds({ [TB_ORACLE_LOOP_ENV]: "0" })).toBe(0)
    expect(resolveOracleLoopRounds({ [TB_ORACLE_LOOP_ENV]: "off" })).toBe(0)
    expect(resolveOracleLoopRounds({ [TB_ORACLE_LOOP_ENV]: "false" })).toBe(0)
  })
  test("1/on/true ⇒ default depth 2; positive int floored + clamped to [1,4]", () => {
    expect(resolveOracleLoopRounds({ [TB_ORACLE_LOOP_ENV]: "1" })).toBe(2)
    expect(resolveOracleLoopRounds({ [TB_ORACLE_LOOP_ENV]: "on" })).toBe(2)
    expect(resolveOracleLoopRounds({ [TB_ORACLE_LOOP_ENV]: "true" })).toBe(2)
    expect(resolveOracleLoopRounds({ [TB_ORACLE_LOOP_ENV]: "3" })).toBe(3)
    expect(resolveOracleLoopRounds({ [TB_ORACLE_LOOP_ENV]: "99" })).toBe(4) // hard cap
    expect(resolveOracleLoopRounds({ [TB_ORACLE_LOOP_ENV]: "2.9" })).toBe(2)
  })
})

describe("ORACLE_LOOP_FEEDBACK (Phase C) — no-leak feedback text", () => {
  test("names only the agent's own self-test + output; never a hidden oracle", () => {
    const text = ORACLE_LOOP_FEEDBACK(
      "ran a self-test the agent authored (did not pass): `python test_fib.py`",
      "AssertionError: fib(5)",
    )
    expect(text).toContain("python test_fib.py")
    expect(text).toContain("AssertionError")
    expect(text.toLowerCase()).toContain("do not seek any concealed")
    // the no-answer-key red line: the feedback must not direct the agent at the hidden oracle
    expect(text.toLowerCase()).not.toMatch(/\/tests\/|hidden test|verifier output|answer key file/)
  })
})

/** Phase C e2e scripts: main run does an exec (the self-test) + a text turn; the loop's feedback
 *  turn does another exec (the re-run) + a text turn. FakeLlm consumes one script per stream turn. */
const oracleLoopScripts = (selfTestCmd: string): StreamEvent[][] => [
  // main run — turn 1: run the self-test
  [
    { type: "tool_use_start", id: "c1", name: "container_exec" },
    { type: "tool_use_end", id: "c1", input: { command: selfTestCmd } },
    { type: "usage", inputTokens: 10, outputTokens: 5, model: "terminal-fake" },
    { type: "message_stop", stop_reason: "tool_use" },
  ],
  // main run — turn 2: finalize (self-test still red at this point)
  [
    { type: "text_delta", delta: "self-test not green yet" },
    { type: "usage", inputTokens: 4, outputTokens: 2, model: "terminal-fake" },
    { type: "message_stop", stop_reason: "end_turn" },
  ],
  // oracle-loop feedback — turn 1: agent re-runs the (now fixed) self-test
  [
    { type: "tool_use_start", id: "c2", name: "container_exec" },
    { type: "tool_use_end", id: "c2", input: { command: selfTestCmd } },
    { type: "usage", inputTokens: 8, outputTokens: 4, model: "terminal-fake" },
    { type: "message_stop", stop_reason: "tool_use" },
  ],
  // oracle-loop feedback — turn 2: done
  [
    { type: "text_delta", delta: "fixed, self-test passes now" },
    { type: "usage", inputTokens: 3, outputTokens: 2, model: "terminal-fake" },
    { type: "message_stop", stop_reason: "end_turn" },
  ],
]

describe("runOracleRepairLoop e2e (Phase C) — drives the self-test to green", () => {
  test("ON: a RED self-test triggers a feedback round; the re-run goes green ⇒ converged", async () => {
    // The self-test `python test_fib.py`: first run RED (code 1), any re-run GREEN (code 0).
    let seen = 0
    const { stdin, stdout, handsServed, endIn } = makeStdio((cmd) =>
      cmd.includes("test_fib.py") ? (seen++ === 0 ? 1 : 0) : 0,
    )
    let report: Record<string, unknown> | undefined
    await runTerminalBrain({
      instruction: "make fib correct",
      reportOut: "/tmp/oracle.json",
      stdin,
      stdout,
      llm: new FakeLlm(oracleLoopScripts("python test_fib.py")),
      writeReport: (_p, obj) => {
        report = obj as Record<string, unknown>
      },
      env: { [TB_ORACLE_LOOP_ENV]: "1" },
    })
    endIn()
    const ol = report?.oracleLoop as { rounds: number; converged: boolean } | undefined
    expect(ol).toBeDefined()
    expect(ol?.rounds).toBe(1) // exactly one repair round fired
    expect(ol?.converged).toBe(true) // the re-run self-test went green
    // the harness actually drove a SECOND self-test exec (the re-run), not just the original.
    expect(handsServed.filter((f) => String(f.command).includes("test_fib.py")).length).toBe(2)
  })

  test("OFF (unset): byte-identical — no oracleLoop field, no extra turn", async () => {
    let seen = 0
    const { stdin, stdout, handsServed, endIn } = makeStdio((cmd) =>
      cmd.includes("test_fib.py") ? (seen++ === 0 ? 1 : 0) : 0,
    )
    let report: Record<string, unknown> | undefined
    await runTerminalBrain({
      instruction: "make fib correct",
      reportOut: "/tmp/oracle.json",
      stdin,
      stdout,
      llm: new FakeLlm(oracleLoopScripts("python test_fib.py")),
      writeReport: (_p, obj) => {
        report = obj as Record<string, unknown>
      },
      // knob unset ⇒ loop off
    })
    endIn()
    expect(report?.oracleLoop).toBeUndefined()
    // no feedback round ⇒ the self-test ran exactly ONCE (only the main run's exec).
    expect(handsServed.filter((f) => String(f.command).includes("test_fib.py")).length).toBe(1)
  })

  test("ON but self-test already GREEN ⇒ zero rounds (no over-persist)", async () => {
    // test_fib.py green on the FIRST run ⇒ nothing to converge ⇒ loop is a no-op.
    const { stdin, stdout, handsServed, endIn } = makeStdio(() => 0)
    let report: Record<string, unknown> | undefined
    await runTerminalBrain({
      instruction: "already correct",
      reportOut: "/tmp/oracle.json",
      stdin,
      stdout,
      llm: new FakeLlm(oracleLoopScripts("python test_fib.py")),
      writeReport: (_p, obj) => {
        report = obj as Record<string, unknown>
      },
      env: { [TB_ORACLE_LOOP_ENV]: "1" },
    })
    endIn()
    const ol = report?.oracleLoop as { rounds: number; converged: boolean } | undefined
    expect(ol?.rounds).toBe(0) // no red ⇒ no feedback round
    expect(ol?.converged).toBe(true)
    expect(handsServed.filter((f) => String(f.command).includes("test_fib.py")).length).toBe(1)
  })

  test("OVER-PERSIST BOUND (final-audit #6): a self-test that stays RED exhausts to exactly maxRounds, converged=false", async () => {
    // test_fib.py is RED on EVERY run (code 1 always) — the agent never fixes it. The loop must NOT
    // spin: the `rounds < maxRounds` hard counter bounds it independently of the turn watchdog.
    const { stdin, stdout, endIn } = makeStdio((cmd) => (cmd.includes("test_fib.py") ? 1 : 0))
    let report: Record<string, unknown> | undefined
    await runTerminalBrain({
      instruction: "cannot converge",
      reportOut: "/tmp/oracle.json",
      stdin,
      stdout,
      llm: new FakeLlm(oracleLoopScripts("python test_fib.py")),
      writeReport: (_p, obj) => {
        report = obj as Record<string, unknown>
      },
      env: { [TB_ORACLE_LOOP_ENV]: "2" }, // maxRounds = 2
    })
    endIn()
    const ol2 = report?.oracleLoop as { rounds: number; converged: boolean } | undefined
    expect(ol2?.rounds).toBe(2) // exhausted the hard round cap, did NOT spin past it
    expect(ol2?.converged).toBe(false) // never went green
  })
})
