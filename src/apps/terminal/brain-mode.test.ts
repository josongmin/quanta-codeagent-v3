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
import { TERMINAL_OPERATOR_GUIDE } from "@/tool"
import type {
  AttachResult,
  PtyHandle,
  PtyResult,
  PtySessionPort,
  ReadResult,
} from "@/tool/pty/port"
import {
  resolveMaxTurnsFromEnv,
  runTerminalBrain,
  TB_ENV_OWNED_ENV,
  TB_VERIFY_GATE_ENV,
  VERIFY_GATE_FOLLOWUP,
} from "./brain-mode"

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
 *  onto `stdin` (the brain's read side). Mirrors `terminal-surface.test.ts#makeDuplex`. */
const makeStdio = () => {
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
            code: 0,
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
    const llm = new FakeLlm(execThenFinalScripts("mkdir -p build", "Implemented and verified green."))
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
      ptyTypeThenFinalScripts("diff mine.out /app/baseline.out", "No diff; matches the baseline. Pass."),
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

  test("v2 RED-for-v1: knob ON + a run that RAN but NEVER COMPARED ⇒ fires the follow-up (no false verified-pass)", async () => {
    const { stdin, stdout, endIn } = makeStdio()
    // v1 rubber-stamped a bare L0 run (`./solver`) as `verified-pass`. Under v2, running without
    // COMPARING to a reference is L0-without-L1 ⇒ the gate MUST fire the compare follow-up. The
    // model then only re-runs (still no diff) ⇒ honest `unverifiable`, NEVER a false green.
    const llm = new FakeLlm(ptyTypeThenFinalScripts("./solver input.txt", "Output looks correct. Verified green."))
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
    expect(sawFollowUp).toBe(true)
    // The critical v2 invariant: a ran-but-unchecked run is NOT verified-pass (rubber-stamp dead).
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

  test("v2 R1 no-leak: knob ON + a diff AGAINST A TEST-PATH golden ⇒ refused (fires follow-up, no verified-pass)", async () => {
    const { stdin, stdout, endIn } = makeStdio()
    // query-optimize's golden lives in /tests/ — a diff against it is peeking at the hidden oracle.
    // The inspector REFUSES it (not L1), so the gate fires the compare follow-up and, with no fair
    // comparison forthcoming, finalizes `unverifiable` — the gate can never TEACH peeking.
    const llm = new FakeLlm(
      ptyTypeThenFinalScripts("diff out.sql /app/tests/golden.sql", "Matches the golden. Verified."),
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
    const sawFollowUp = llm.seen.some((s) =>
      s.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "text" && b.text.includes(VERIFY_GATE_FOLLOWUP)),
      ),
    )
    expect(sawFollowUp).toBe(true)
    expect(result.report.verification?.state).not.toBe("verified-pass")
    // The no-leak guard is also pinned at the source: the follow-up text names no hidden-oracle terms.
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
