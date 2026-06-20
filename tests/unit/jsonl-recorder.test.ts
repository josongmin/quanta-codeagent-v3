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

  test("ADR-0512 P3: escalation pair serializes auditable fields; justification is conditional (no undefined key)", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({
      type: "permission_escalation_requested",
      id: "esc-edit-1",
      tool: "edit",
      risk: "mutating",
      activeSkill: "localize-fault",
      reason: "localize-fault is a read-only skill",
      justification: "fix the bug at src/foo.ts:42",
      options: ["allow_once", "allow_session", "deny", "deny_and_steer"],
    })
    rec.emit({
      type: "permission_escalation_requested",
      id: "esc-read-2",
      tool: "read",
      risk: "read-only",
      activeSkill: "localize-fault",
      reason: "ladder tool",
      options: ["allow_once", "deny"],
      // NO justification ⇒ the key must be OMITTED, not serialized as undefined.
    })
    rec.emit({ type: "permission_escalation_resolved", id: "esc-edit-1", decision: "allow_session" })
    rec.close()

    const [req1, req2, res] = readLines(path)
    // requested (with justification)
    expect(req1?.kind).toBe("recovery") // rides the recovery family (greppable via reason)
    expect(req1?.data.reason).toBe("escalation_requested")
    expect(req1?.data.id).toBe("esc-edit-1")
    expect(req1?.data.tool).toBe("edit")
    expect(req1?.data.risk).toBe("mutating")
    expect(req1?.data.activeSkill).toBe("localize-fault")
    expect(req1?.data.scopeReason).toBe("localize-fault is a read-only skill")
    expect(req1?.data.options).toEqual(["allow_once", "allow_session", "deny", "deny_and_steer"])
    expect(req1?.data.justification).toBe("fix the bug at src/foo.ts:42")
    // requested (no justification) ⇒ key omitted entirely
    expect(req2?.data.justification).toBeUndefined()
    expect("justification" in (req2?.data ?? {})).toBe(false)
    // resolved
    expect(res?.kind).toBe("recovery")
    expect(res?.data.reason).toBe("escalation_resolved")
    expect(res?.data.id).toBe("esc-edit-1")
    expect(res?.data.decision).toBe("allow_session")
  })

  test("llm_request maps to kind:llm_request with data {model}", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "llm_request", model: "claude-x" })
    rec.close()

    const [line] = readLines(path)
    expect(line?.kind).toBe("llm_request")
    expect(line?.data).toEqual({ model: "claude-x" })
  })

  test("llm_request preserves optional route metadata when present", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({
      type: "llm_request",
      model: "gpt-5",
      provider: "chatgpt-oauth",
      surfaceId: "openai-responses",
      transportId: "chatgpt-oauth",
      authMode: "ChatGPT subscription",
      policy: {
        mode: "review",
        baseSystem: "default",
        systemLayout: "single_block",
        repoRulesPresent: true,
        sessionCtxPresent: false,
        userAppendPresent: false,
        selectedGlobRuleNames: ["react.mdc"],
        activeSkillNames: ["rr"],
        workingStatePresent: false,
        memoryContextPresent: true,
        contextChangeCount: 0,
        mentionInjectionCount: 1,
        hookContext: "after_system",
        summaryPrefix: "conversation_summary",
        toolChoice: "any",
        promptCacheKeyPresent: true,
      },
    })
    rec.close()

    const [line] = readLines(path)
    expect(line?.kind).toBe("llm_request")
    expect(line?.data).toEqual({
      model: "gpt-5",
      provider: "chatgpt-oauth",
      surfaceId: "openai-responses",
      transportId: "chatgpt-oauth",
      authMode: "ChatGPT subscription",
      policy: {
        mode: "review",
        baseSystem: "default",
        systemLayout: "single_block",
        repoRulesPresent: true,
        sessionCtxPresent: false,
        userAppendPresent: false,
        selectedGlobRuleNames: ["react.mdc"],
        activeSkillNames: ["rr"],
        workingStatePresent: false,
        memoryContextPresent: true,
        contextChangeCount: 0,
        mentionInjectionCount: 1,
        hookContext: "after_system",
        summaryPrefix: "conversation_summary",
        toolChoice: "any",
        promptCacheKeyPresent: true,
      },
    })
  })

  test("llm_continuation maps to kind:recovery with continuation payload on the llm span", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit({ type: "llm_request", model: "gpt-5" })
    rec.emit({
      type: "llm_continuation",
      provider: "openai",
      surfaceId: "openai-responses",
      transportId: "public",
      phase: "prepare",
      mode: "resume",
      reason: "prepared_resume",
    })
    rec.emit({ type: "usage", inputTokens: 3, outputTokens: 4, model: "gpt-5" })
    rec.close()

    const [, req, continuation, usage] = readLines(path)
    expect(continuation?.kind).toBe("recovery")
    expect(continuation?.data).toEqual({
      reason: "llm_continuation",
      provider: "openai",
      surfaceId: "openai-responses",
      transportId: "public",
      phase: "prepare",
      mode: "resume",
      continuationReason: "prepared_resume",
    })
    expect(req?.spanId).toBe(continuation?.spanId)
    expect(continuation?.spanId).toBe(usage?.spanId)
  })

  test("§11 span pair: llm_request and the turn's llm_usage share ONE span", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit({ type: "llm_request", model: "m" })
    rec.emit({ type: "usage", inputTokens: 3, outputTokens: 4, model: "m" })
    rec.close()

    const [ts, req, usage] = readLines(path)
    const turnSpan = ts?.spanId
    expect(turnSpan).toBeDefined()
    expect(req?.kind).toBe("llm_request")
    expect(usage?.kind).toBe("llm_usage")
    // The point of RFC-0002 §5.2/§9/§11: request↔usage are paired by ONE span.
    expect(req?.spanId).toBe(`llm:${turnSpan}`)
    expect(usage?.spanId).toBe(`llm:${turnSpan}`)
    expect(req?.spanId).toBe(usage?.spanId)
    expect(req?.parentSpanId).toBe(turnSpan)
    expect(usage?.parentSpanId).toBe(turnSpan)
  })

  test("a secret in the llm_request model field is still ***REDACTED***", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "llm_request", model: "sk-abcdef1234567890" })
    rec.close()

    const raw = readFileSync(path, "utf8")
    expect(raw).not.toContain("sk-abcdef1234567890")
    expect(raw).toContain("REDACTED")
    const [line] = readLines(path)
    expect(line?.data.model).toBe("***REDACTED***")
    expect(line?.redaction.applied).toBe(true)
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
      executedCommand: "pytest tests/test_x.py -k repro",
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
    expect(line?.data.executedCommand).toBe("pytest tests/test_x.py -k repro")
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

  test("flush() failure preserves the buffer for retry (no silent drop)", () => {
    const path = join(dir, "i1.0.jsonl")
    // Batch < FLUSH_BATCH so nothing flushes on emit; the events sit buffered.
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit({ type: "assistant_text", delta: "x" })

    // First flush throws (disk full); buffer must NOT be cleared.
    let fail = true
    const orig = (rec as unknown as { flush(): void }).flush.bind(rec)
    const buf = (rec as unknown as { buf: string[] }).buf
    ;(rec as unknown as { flush(): void }).flush = () => {
      if (fail) throw new Error("disk full")
      orig()
    }
    expect(() => (rec as unknown as { flush(): void }).flush()).toThrow("disk full")
    // The two buffered lines are still pending — they were not dropped.
    expect(buf.length).toBe(2)

    // Recover: a real flush now drains the preserved buffer to disk.
    fail = false
    ;(rec as unknown as { flush(): void }).flush = orig
    rec.close()
    expect(readLines(path)).toHaveLength(2)
  })

  test("close() never throws even when the final flush fails (non-strict)", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, ...fixedClocks() })
    rec.emit({ type: "turn_start", turn: 1 })
    ;(rec as unknown as { flush(): void }).flush = () => {
      throw new Error("volume gone")
    }
    expect(() => rec.close()).not.toThrow()
    // The failure is surfaced via the degraded snapshot, not swallowed silently.
    expect(rec.degraded().length).toBeGreaterThanOrEqual(1)
  })

  test("strict mode: a failing final flush rethrows from close()", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, { ctx: CTX, strict: true, ...fixedClocks() })
    rec.emit({ type: "turn_start", turn: 1 })
    ;(rec as unknown as { flush(): void }).flush = () => {
      throw new Error("volume gone")
    }
    expect(() => rec.close()).toThrow("volume gone")
  })
})
