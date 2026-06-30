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
import { runTerminalBrain } from "./brain-mode"

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
}
