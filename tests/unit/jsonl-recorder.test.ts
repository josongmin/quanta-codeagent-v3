import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunContext, TrajectoryEvent } from "@/shared"
import { isTrajectoryEvent } from "@/shared"
import { JsonlRecorder } from "../../src/stream/adapters/jsonl-recorder"
import type { AgentEvent } from "../../src/stream/types"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jsonl-rec-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CTX: RunContext = { runId: "r1", instanceId: "i1", attempt: 0 }

const fixedClocks = () => ({ now: () => 1_700_000_000_000, monotonic: () => 42 })

const readLines = (path: string): TrajectoryEvent[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TrajectoryEvent)

describe("JsonlRecorder — normalization", () => {
  test("maps every AgentEvent type to the correct TrajectoryEvent kind", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    const events: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      { type: "assistant_text", delta: "hello" },
      { type: "tool_call", id: "tu1", name: "bash", input: { cmd: "ls" } },
      { type: "tool_progress", id: "tu1", name: "bash", message: "running" },
      { type: "tool_result", id: "tu1", name: "bash", ok: true, preview: "out" },
      { type: "error", message: "kaboom" },
      { type: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, model: "gpt-x" },
      { type: "done", reason: "stop", turns: 1 },
    ]
    for (const e of events) rec.emit(e)
    rec.close()

    const lines = readLines(path)
    expect(lines.map((l) => l.kind)).toEqual([
      "turn_start",
      "assistant_text",
      "tool_call",
      "tool_progress",
      "tool_result",
      "error",
      "llm_usage",
      "session_end",
    ])
  })

  test("every written line is a valid TrajectoryEvent (valid JSONL)", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit({ type: "assistant_text", delta: "x" })
    rec.close()

    for (const l of readLines(path)) {
      expect(isTrajectoryEvent(l)).toBe(true)
    }
  })

  test("tool_result data carries name/ok and the preview", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "tool_result", id: "t", name: "edit", ok: false, preview: "diff..." })
    rec.close()

    const [line] = readLines(path)
    expect(line?.data.name).toBe("edit")
    expect(line?.data.ok).toBe(false)
    expect(line?.data.stdoutTail).toBe("diff...")
  })

  test("llm_usage costUsd is null (recorder cannot import pricing)", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "usage", inputTokens: 1, outputTokens: 2, model: "m" })
    rec.close()

    const [line] = readLines(path)
    expect(line?.kind).toBe("llm_usage")
    expect(line?.data.costUsd).toBeNull()
    expect(line?.data.model).toBe("m")
    expect(line?.data.inputTokens).toBe(1)
    expect(line?.data.outputTokens).toBe(2)
  })

  test("assistant_text deltas are preserved, not coalesced (3 deltas => 3 events)", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "assistant_text", delta: "a" })
    rec.emit({ type: "assistant_text", delta: "b" })
    rec.emit({ type: "assistant_text", delta: "c" })
    rec.close()

    const lines = readLines(path)
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.data.delta)).toEqual(["a", "b", "c"])
  })
})

describe("JsonlRecorder — RFC-0002 §5.2 new variants", () => {
  test("session_start maps to kind:session_start with minimal data", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "session_start" })
    rec.close()

    const [line] = readLines(path)
    expect(line?.kind).toBe("session_start")
    expect(line?.data).toEqual({})
  })

  test("recovery maps to kind:recovery with reason and optional detail", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "recovery", reason: "backoff" })
    rec.emit({ type: "recovery", reason: "compact", detail: "ctx 92% full" })
    rec.close()

    const [bare, withDetail] = readLines(path)
    expect(bare?.kind).toBe("recovery")
    expect(bare?.data.reason).toBe("backoff")
    expect(bare?.data.detail).toBeUndefined()
    expect(withDetail?.data.reason).toBe("compact")
    expect(withDetail?.data.detail).toBe("ctx 92% full")
  })

  test("enriched tool_result carries §5.2 ToolResultData evidence", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({
      type: "tool_result",
      id: "tu1",
      name: "bash",
      ok: false,
      preview: "stdout tail",
      durationMs: 37,
      stderrTail: "boom on line 3",
      exitCode: 1,
      fullLogPath: "/tmp/run/tu1.log",
    })
    rec.close()

    const [line] = readLines(path)
    expect(line?.kind).toBe("tool_result")
    expect(line?.data.name).toBe("bash")
    expect(line?.data.ok).toBe(false)
    expect(line?.data.stdoutTail).toBe("stdout tail")
    expect(line?.data.durationMs).toBe(37)
    expect(line?.data.stderrTail).toBe("boom on line 3")
    expect(line?.data.exitCode).toBe(1)
    expect(line?.data.fullLogPath).toBe("/tmp/run/tu1.log")
  })

  test("tool_result without evidence omits optional fields (no nulls)", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "tool_result", id: "t", name: "read", ok: true, preview: "file body" })
    rec.close()

    const [line] = readLines(path)
    expect(line?.data).toEqual({ name: "read", ok: true, stdoutTail: "file body" })
    expect("durationMs" in (line?.data ?? {})).toBe(false)
    expect("stderrTail" in (line?.data ?? {})).toBe(false)
  })

  test("a secret in stderrTail/preview is still ***REDACTED*** on disk", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({
      type: "tool_result",
      id: "t",
      name: "bash",
      ok: false,
      preview: "leaked OPENAI key sk-abcdef1234567890 here",
      stderrTail: "auth failed: Bearer abc.def.ghi",
      durationMs: 5,
    })
    rec.close()

    const raw = readFileSync(path, "utf8")
    expect(raw).not.toContain("sk-abcdef1234567890")
    expect(raw).not.toContain("Bearer abc.def.ghi")
    expect(raw).toContain("REDACTED")
    const [line] = readLines(path)
    expect(line?.redaction.applied).toBe(true)
  })
})

describe("JsonlRecorder — seq & span", () => {
  test("seq is strictly increasing from 0", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit({ type: "assistant_text", delta: "a" })
    rec.emit({ type: "error", message: "e" })
    rec.close()

    expect(readLines(path).map((l) => l.seq)).toEqual([0, 1, 2])
  })

  test("span scheme: turn span, tool span, llm span correlate deterministically", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit({ type: "tool_call", id: "tu1", name: "bash", input: {} })
    rec.emit({ type: "tool_progress", id: "tu1", name: "bash", message: "..." })
    rec.emit({ type: "tool_result", id: "tu1", name: "bash", ok: true, preview: "ok" })
    rec.emit({ type: "usage", inputTokens: 1, outputTokens: 1, model: "m" })
    rec.close()

    const [ts, call, prog, res, usage] = readLines(path)
    const turnSpan = ts?.spanId
    expect(turnSpan).toBeDefined()
    expect(call?.spanId).toBe("tool:tu1")
    expect(prog?.spanId).toBe("tool:tu1")
    expect(res?.spanId).toBe("tool:tu1")
    expect(call?.parentSpanId).toBe(turnSpan)
    expect(res?.parentSpanId).toBe(turnSpan)
    expect(usage?.spanId).toBe(`llm:${turnSpan}`)
    expect(usage?.parentSpanId).toBe(turnSpan)
  })

  test("seq and spans are deterministic across two identical runs", () => {
    const seq = (p: string): string => {
      const rec = new JsonlRecorder(p, { ctx: CTX, ...fixedClocks() })
      rec.emit({ type: "turn_start", turn: 1 })
      rec.emit({ type: "tool_call", id: "tu1", name: "b", input: {} })
      rec.emit({ type: "tool_result", id: "tu1", name: "b", ok: true, preview: "o" })
      rec.emit({ type: "usage", inputTokens: 2, outputTokens: 3, model: "m" })
      rec.close()
      return readFileSync(p, "utf8")
    }
    expect(seq(join(dir, "a.jsonl"))).toBe(seq(join(dir, "b.jsonl")))
  })
})

describe("JsonlRecorder — redaction", () => {
  test("secrets in event data are masked on disk", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({
      type: "tool_call",
      id: "t",
      name: "bash",
      input: { OPENAI_API_KEY: "sk-abcdef123456", auth: "Bearer abc.def.ghi" },
    })
    rec.close()

    const raw = readFileSync(path, "utf8")
    expect(raw).not.toContain("sk-abcdef123456")
    expect(raw).not.toContain("Bearer abc.def.ghi")
    expect(raw).toContain("REDACTED")
    const [line] = readLines(path)
    expect(line?.redaction.applied).toBe(true)
  })
})

describe("JsonlRecorder — failure handling", () => {
  const breakSink = (rec: JsonlRecorder): void => {
    // Monkeypatch the private buffered append to force a write failure.
    ;(rec as unknown as { writeLine(s: string): void }).writeLine = () => {
      throw new Error("disk full")
    }
  }

  test("non-strict: write failure is swallowed; degraded() counts; emit does not throw", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    breakSink(rec)

    expect(() => rec.emit({ type: "turn_start", turn: 1 })).not.toThrow()
    expect(() => rec.emit({ type: "assistant_text", delta: "x" })).not.toThrow()

    const d = rec.degraded()
    expect(d).toHaveLength(1)
    expect(d[0]?.component).toBe("JsonlRecorder")
    expect(d[0]?.count).toBeGreaterThanOrEqual(2)
  })

  test("strict: write failure rethrows", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, strict: true, ...fixedClocks() })
    breakSink(rec)

    expect(() => rec.emit({ type: "turn_start", turn: 1 })).toThrow("disk full")
  })

  test("maxLines is respected and a final observability_degraded line is allowed", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, maxLines: 2, ...fixedClocks() })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit({ type: "assistant_text", delta: "a" })
    rec.emit({ type: "assistant_text", delta: "b" })
    rec.emit({ type: "assistant_text", delta: "c" })
    rec.close()

    const lines = readLines(path)
    const normal = lines.filter((l) => l.kind !== "observability_degraded")
    const degraded = lines.filter((l) => l.kind === "observability_degraded")
    expect(normal).toHaveLength(2)
    expect(degraded).toHaveLength(1)
    expect(degraded[0]?.data.reason).toBe("line_cap")
  })

  test("close() is idempotent and flushes", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.close()
    expect(() => rec.close()).not.toThrow()
    expect(readLines(path)).toHaveLength(1)
  })
})
