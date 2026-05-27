import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AgentEvent } from "@/stream"
import { StdoutStream } from "@/stream"

const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const RESET = "\x1b[0m"

const realWrite = process.stdout.write.bind(process.stdout)
let captured: string[]

beforeEach(() => {
  captured = []
  // StdoutStream writes straight to process.stdout.write with no injection
  // point, so we intercept the sink and restore it in afterEach.
  process.stdout.write = ((chunk: unknown): boolean => {
    captured.push(String(chunk))
    return true
  }) as typeof process.stdout.write
})

afterEach(() => {
  process.stdout.write = realWrite
})

const out = (): string => captured.join("")

describe("StdoutStream", () => {
  test("turn_start renders a dim banner with the turn number", () => {
    new StdoutStream().emit({ type: "turn_start", turn: 3 })
    expect(out()).toBe(`${DIM}— turn 3 —${RESET}\n`)
  })

  test("assistant_text streams the delta verbatim with no trailing newline", () => {
    const s = new StdoutStream()
    s.emit({ type: "assistant_text", delta: "Hello " })
    s.emit({ type: "assistant_text", delta: "world" })
    expect(out()).toBe("Hello world")
  })

  test("a non-text event after streamed text flushes a newline first", () => {
    const s = new StdoutStream()
    s.emit({ type: "assistant_text", delta: "partial answer" })
    s.emit({ type: "done", reason: "stop", turns: 2 })
    expect(captured[0]).toBe("partial answer")
    expect(captured[1]).toBe("\n")
    expect(captured[2]).toBe(`${DIM}— done (stop, 2 turns) —${RESET}\n`)
  })

  test("no spurious flush newline when not currently in text", () => {
    const s = new StdoutStream()
    s.emit({ type: "turn_start", turn: 1 })
    s.emit({ type: "done", reason: "stop", turns: 1 })
    expect(captured).toEqual([
      `${DIM}— turn 1 —${RESET}\n`,
      `${DIM}— done (stop, 1 turns) —${RESET}\n`,
    ])
  })

  test("tool_call renders a cyan glyph and compacted JSON input", () => {
    new StdoutStream().emit({
      type: "tool_call",
      id: "t1",
      name: "read",
      input: { path: "/x", lines: 5 },
    })
    expect(out()).toBe(`${CYAN}⚙ read${RESET} ${DIM}{"path":"/x","lines":5}${RESET}\n`)
  })

  test("tool_progress collapses whitespace in the message", () => {
    new StdoutStream().emit({
      type: "tool_progress",
      id: "t1",
      name: "grep",
      message: "scanning\n  many   files",
    })
    expect(out()).toBe(`${DIM}  ↳ grep: scanning many files${RESET}\n`)
  })

  test("tool_result uses a green check when ok", () => {
    new StdoutStream().emit({
      type: "tool_result",
      id: "t1",
      name: "write",
      ok: true,
      preview: "wrote 10 bytes",
    })
    expect(out()).toBe(`${GREEN}✓${RESET} ${DIM}write: wrote 10 bytes${RESET}\n`)
  })

  test("tool_result uses a red cross when not ok", () => {
    new StdoutStream().emit({
      type: "tool_result",
      id: "t1",
      name: "write",
      ok: false,
      preview: "denied",
    })
    expect(out()).toBe(`${RED}✗${RESET} ${DIM}write: denied${RESET}\n`)
  })

  test("error renders a red error line", () => {
    new StdoutStream().emit({ type: "error", message: "kaboom" })
    expect(out()).toBe(`${RED}error: kaboom${RESET}\n`)
  })

  test("long previews are truncated to 160 chars with an ellipsis", () => {
    const long = "x".repeat(300)
    new StdoutStream().emit({
      type: "tool_result",
      id: "t1",
      name: "read",
      ok: true,
      preview: long,
    })
    const rendered = out()
    expect(rendered).toContain(`${"x".repeat(160)}…`)
    expect(rendered).not.toContain("x".repeat(161))
  })

  test("S4: a secret in assistant_text is redacted, benign text untouched", () => {
    const secret = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
    const s = new StdoutStream()
    s.emit({ type: "assistant_text", delta: `the token is ${secret} done` })
    const rendered = out()
    expect(rendered).not.toContain(secret)
    expect(rendered).toContain("***REDACTED***")

    captured = []
    new StdoutStream().emit({ type: "assistant_text", delta: "plain text here" })
    expect(out()).toBe("plain text here")
  })

  test("S4: secrets in tool_call input and tool_result preview/stderrTail redacted", () => {
    const secret = "Bearer abcdef0123456789ghijklmnop"
    const s = new StdoutStream()
    s.emit({ type: "tool_call", id: "t1", name: "bash", input: { auth: secret } })
    s.emit({
      type: "tool_result",
      id: "t1",
      name: "bash",
      ok: false,
      preview: `out ${secret}`,
      stderrTail: `err ${secret}`,
    })
    const rendered = out()
    expect(rendered).not.toContain(secret)
    expect(rendered).toContain("***REDACTED***")
    expect(rendered).toContain("stderr:")
  })

  test("S4: secret in error message is redacted", () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
    new StdoutStream().emit({ type: "error", message: `boom ${secret}` })
    const rendered = out()
    expect(rendered).not.toContain(secret)
    expect(rendered).toContain("***REDACTED***")
  })

  test("new session_start / recovery variants render without throwing", () => {
    const s = new StdoutStream()
    expect(() => {
      s.emit({ type: "session_start" })
      s.emit({ type: "recovery", reason: "compact", detail: "context trimmed" })
    }).not.toThrow()
    const rendered = out()
    expect(rendered).toContain("session start")
    expect(rendered).toContain("recovery (compact)")
  })

  test("llm_continuation renders a dim continuation status line", () => {
    new StdoutStream().emit({
      type: "llm_continuation",
      provider: "openai",
      surfaceId: "openai-responses",
      transportId: "public",
      phase: "retry",
      mode: "full_retry",
      reason: "resume_rejected",
      statusCode: 400,
    })
    expect(out()).toBe(`${DIM}↺ continuation (full_retry/retry: resume_rejected 400)${RESET}\n`)
  })

  test("implements StreamPort.emit and renders all variants once each", () => {
    const events: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      { type: "assistant_text", delta: "hi" },
      { type: "tool_call", id: "a", name: "read", input: {} },
      { type: "tool_progress", id: "a", name: "read", message: "go" },
      { type: "tool_result", id: "a", name: "read", ok: true, preview: "p" },
      { type: "error", message: "e" },
      { type: "done", reason: "stop", turns: 1 },
    ]
    const s = new StdoutStream()
    for (const e of events) s.emit(e)
    // Every event produced output (text flush adds extra entries but never zero).
    expect(captured.length).toBeGreaterThanOrEqual(events.length)
    expect(out()).toContain("done (stop, 1 turns)")
  })
})
