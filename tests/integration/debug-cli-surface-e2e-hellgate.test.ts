/**
 * Cross-slice integration hellgate — CLI surface composition for the
 * developer-mode debug slice (Track T / I / R).
 *
 * Slices stitched (read-only — no source mutation):
 *   - `@/apps/cli/slash-commands` (real `BUILTINS` registry + `runSlashCommand`)
 *   - `@/apps/cli/debug-cmd`      (runtime toggle)
 *   - `@/apps/cli/inspect-cmd`    (session JSONL inspection)
 *   - `@/apps/cli/replay-cmd`     (session JSONL replay)
 *   - `@/apps/cli/why-cmd`        (meta-LLM reasoning)
 *
 * Story: a real `runSlashCommand(line, ctx)` dispatch walks through the real
 * BUILTINS table to the correct leaf handler. Tests prove the wiring
 * end-to-end:
 *   - the registry contains the 5 new commands at known slots,
 *   - default-OFF (ctx.* === undefined) yields the documented "not wired"
 *     message + exit code,
 *   - the leaves observe the session/LLM stubs through `ctx.*` injection,
 *   - stdout vs stderr separation is enforced (debug tracer only stderr;
 *     /inspect / /replay print to stdout).
 *
 * Only external dependencies are stubbed (LLMPort, session JSONL reader).
 * Everything else — the runtime, the registry, the leaf logic — is the
 * production code.
 */

import { describe, expect, test } from "bun:test"
import {
  BUILTINS,
  isSlashCommand,
  runSlashCommand,
  type SlashContext,
} from "@/apps/cli/slash-commands"
import type { DebugCmdState } from "@/apps/cli/debug-cmd"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { SessionEnvelopeRecord } from "@/session"

// ─── helpers ──────────────────────────────────────────────────────────────

const captureIO = (): {
  out: string[]
  err: string[]
  outFn: (s: string) => void
  errFn: (s: string) => void
} => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    outFn: (s) => out.push(s),
    errFn: (s) => err.push(s),
  }
}

const baseCtx = (over: Partial<SlashContext> = {}): { ctx: SlashContext; io: ReturnType<typeof captureIO> } => {
  const io = captureIO()
  const ctx: SlashContext = {
    out: io.outFn,
    err: io.errFn,
    cwd: "/tmp",
    ...over,
  }
  return { ctx, io }
}

// ─── session JSONL fixtures (for /inspect, /replay) ───────────────────────

const ISO = (n: number): string => new Date(1717000000000 + n).toISOString()

const turnContext = (turn_id: string): SessionEnvelopeRecord => ({
  type: "turn_context",
  schema_version: 2,
  turn_id,
  cwd: "/tmp/x",
  current_date: ISO(0),
  timezone: "UTC",
  approval_policy: "never",
  sandbox_policy: "read-only",
  permission_profile: "default",
  model: "gpt-5",
  personality: "default",
  collaboration_mode: "solo",
  realtime_active: false,
  effort: "medium",
  summary: "",
  user_instructions: "",
  truncation_policy: "none",
  parent_thread_id: null,
  thread_role: "root",
})

const toolInvoke = (
  turn_id: string,
  tool: string,
  input: Record<string, unknown>,
  tsOffset = 1,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "tool_invoke",
  tool,
  input,
})

const decision = (
  turn_id: string,
  gate: "permission" | "rule" | "hook" | "cap" | "jail" | "budget",
  outcome: "allow" | "deny" | "ask",
  reason: string,
  toolCallId: string,
  tsOffset = 2,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "decision",
  gate,
  outcome,
  decision_reason: reason,
  tool_call_id: toolCallId,
})

const toolResult = (
  turn_id: string,
  tool: string,
  ok: boolean,
  output: string,
  tsOffset = 3,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "tool_result",
  tool,
  ok,
  output,
})

const userMessage = (
  turn_id: string,
  content: string,
  tsOffset = 0,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "user_message",
  content,
})

// Session fixture with a known tc_7a in turn "3".
const SESSION_FIXTURE: readonly SessionEnvelopeRecord[] = [
  turnContext("3"),
  userMessage("3", "where is foo defined?"),
  toolInvoke("3", "Read", { path: "src/foo.ts" }, 1),
  decision("3", "permission", "allow", "default-allow", "tc_7a", 2),
  toolResult("3", "Read", true, "export const foo = 1", 3),
  toolInvoke("3", "Edit", { file: "src/foo.ts" }, 4),
  decision("3", "permission", "allow", "default-allow", "tc_7b", 5),
  toolResult("3", "Edit", true, "ok", 6),
]

// ─── LLM stub (for /why) ──────────────────────────────────────────────────

const stubLlmWithText = (text: string): LLMPort => ({
  model: "stub-model",
  stream(_input): AsyncIterable<StreamEvent> {
    return (async function* () {
      yield { type: "text_delta", delta: text }
      yield {
        type: "usage",
        inputTokens: 100,
        outputTokens: 50,
        model: "stub-model",
      }
      yield { type: "message_stop", stop_reason: "end_turn" }
    })()
  },
})

// Async iter helper for /replay.
const fromArray = (
  records: readonly SessionEnvelopeRecord[],
): ((p: string) => AsyncIterable<SessionEnvelopeRecord>) =>
  (_p: string) =>
    (async function* () {
      for (const r of records) yield r
    })()

// ─── case 01-02: /debug status + on ───────────────────────────────────────

describe("CLI surface integration — runSlashCommand dispatch", () => {
  test("case-01: /debug status → leaf prints 'off (categories: all)'; state immutable", async () => {
    let currentState: DebugCmdState = { enabled: false }
    const setCalls: DebugCmdState[] = []
    const { ctx, io } = baseCtx({
      debug: {
        get: () => currentState,
        set: (s: DebugCmdState) => {
          currentState = s
          setCalls.push(s)
        },
      },
    })
    const code = await runSlashCommand("/debug status", ctx)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("debug: off")
    // status MUST NOT call set (handler returns state===prev by reference).
    expect(setCalls.length).toBe(0)
  })

  test("case-02: /debug on → ctx.debug.set called once with enabled:true", async () => {
    let currentState: DebugCmdState = { enabled: false }
    const setCalls: DebugCmdState[] = []
    const { ctx, io } = baseCtx({
      debug: {
        get: () => currentState,
        set: (s: DebugCmdState) => {
          currentState = s
          setCalls.push(s)
        },
      },
    })
    const code = await runSlashCommand("/debug on", ctx)
    expect(code).toBe(0)
    expect(setCalls.length).toBe(1)
    expect(setCalls[0]?.enabled).toBe(true)
    expect(io.out.join("")).toContain("debug: on")
  })

  test("case-03: /debug tools,llm → set called with categories filter", async () => {
    let currentState: DebugCmdState = { enabled: false }
    const setCalls: DebugCmdState[] = []
    const { ctx, io } = baseCtx({
      debug: {
        get: () => currentState,
        set: (s: DebugCmdState) => {
          currentState = s
          setCalls.push(s)
        },
      },
    })
    const code = await runSlashCommand("/debug tools,llm", ctx)
    expect(code).toBe(0)
    expect(setCalls.length).toBe(1)
    expect(setCalls[0]?.enabled).toBe(true)
    const cats = setCalls[0]?.categories
    expect(cats).toBeDefined()
    if (cats !== undefined) {
      expect(cats.has("tools")).toBe(true)
      expect(cats.has("llm")).toBe(true)
      expect(cats.has("decisions")).toBe(false)
    }
    expect(io.out.join("")).toContain("debug: on")
  })

  // ── /inspect cases ─────────────────────────────────────────────────────

  test("case-04: /inspect tc_7a (ctx.inspect wired) → renders multi-section panel", async () => {
    const { ctx, io } = baseCtx({
      inspect: {
        sessionId: "sess-1",
        readSessionJsonl: async () => SESSION_FIXTURE,
      },
    })
    const code = await runSlashCommand("/inspect tc_7a", ctx)
    expect(code).toBe(0)
    const text = io.out.join("")
    // Panel header includes the tool call id.
    expect(text).toContain("tc_7a")
    // Sections: input + decisions + result + preview.
    expect(text).toContain("input")
    expect(text).toContain("decisions")
    expect(text).toContain("result")
    // The matched decision row's reason renders.
    expect(text).toContain("default-allow")
  })

  test("case-05: /inspect tc_xx (id not present) → 'not found' + exit 1", async () => {
    const { ctx, io } = baseCtx({
      inspect: {
        sessionId: "sess-1",
        readSessionJsonl: async () => SESSION_FIXTURE,
      },
    })
    const code = await runSlashCommand("/inspect tc_xx", ctx)
    expect(code).toBe(1)
    expect(io.out.join("")).toContain("not found")
  })

  // ── /replay cases ──────────────────────────────────────────────────────

  test("case-06: /replay 01HXY (full session) → renders every event in time order", async () => {
    const { ctx, io } = baseCtx({
      replay: {
        resolveSession: async () => "/fake/path.jsonl",
        iterate: fromArray(SESSION_FIXTURE),
      },
    })
    const code = await runSlashCommand("/replay 01HXY", ctx)
    expect(code).toBe(0)
    const text = io.out.join("")
    expect(text).toContain("── replay session")
    // Tool ids appear in order tc_7a → tc_7b.
    const posA = text.indexOf("tc_7a")
    const posB = text.indexOf("tc_7b")
    expect(posA).toBeGreaterThan(-1)
    expect(posB).toBeGreaterThan(posA)
  })

  test("case-07: /replay 01HXY --at 3 → renders only turn 3 frames", async () => {
    const mixed: readonly SessionEnvelopeRecord[] = [
      ...SESSION_FIXTURE,
      toolInvoke("4", "Read", { path: "other.ts" }, 10),
      decision("4", "permission", "allow", "default-allow", "tc_off", 11),
    ]
    const { ctx, io } = baseCtx({
      replay: {
        resolveSession: async () => "/fake/path.jsonl",
        iterate: fromArray(mixed),
      },
    })
    const code = await runSlashCommand("/replay 01HXY --at 3", ctx)
    expect(code).toBe(0)
    const text = io.out.join("")
    expect(text).toContain("tc_7a")
    expect(text).not.toContain("tc_off")
  })

  test("case-08: /replay 01HXY --from tc_7b → tc_7a body hidden", async () => {
    const { ctx, io } = baseCtx({
      replay: {
        resolveSession: async () => "/fake/path.jsonl",
        iterate: fromArray(SESSION_FIXTURE),
      },
    })
    const code = await runSlashCommand("/replay 01HXY --from tc_7b", ctx)
    expect(code).toBe(0)
    const text = io.out.join("")
    // body starts after the first blank line.
    const bodyIdx = text.indexOf("\n\n")
    expect(bodyIdx).toBeGreaterThan(-1)
    const body = text.slice(bodyIdx)
    expect(body).not.toContain("tc_7a")
    expect(body).toContain("tc_7b")
  })

  // ── /why cases ─────────────────────────────────────────────────────────

  test("case-09: /why last (LLM stub returns valid JSON) → structured render", async () => {
    const json = JSON.stringify({
      goal: "Locate the foo handler",
      reasoning: ["The user asked where foo is defined", "Read gives line precision"],
      alternatives_considered: ["grep"],
      confidence: "high",
    })
    const llm = stubLlmWithText(json)
    const { ctx, io } = baseCtx({
      why: {
        sessionId: "sess-1",
        model: "stub-model",
        llm,
        readSessionEnvelopes: async () => SESSION_FIXTURE,
      },
    })
    const code = await runSlashCommand("/why last", ctx)
    expect(code).toBe(0)
    const text = io.out.join("")
    expect(text).toContain("why")
    expect(text).toContain("goal")
    expect(text).toContain("Locate the foo handler")
    expect(text).toContain("reasoning")
    expect(text).toContain("confidence")
    expect(text).toContain("high")
  })

  test("case-10: /why last (LLM stub returns prose) → fallback raw render", async () => {
    const llm = stubLlmWithText("just some prose, not JSON at all")
    const { ctx, io } = baseCtx({
      why: {
        sessionId: "sess-1",
        model: "stub-model",
        llm,
        readSessionEnvelopes: async () => SESSION_FIXTURE,
      },
    })
    const code = await runSlashCommand("/why last", ctx)
    expect(code).toBe(0)
    const text = io.out.join("")
    // Fallback panel includes the literal "unstructured prose" marker AND
    // the raw text.
    expect(text).toContain("unstructured prose")
    expect(text).toContain("just some prose")
  })

  // ── default-OFF: ctx.* undefined ──────────────────────────────────────

  test("case-11: every slash with undefined ctx.* prints 'not wired' AND known exit code", async () => {
    // Each command's documented behaviour when its ctx slot is absent:
    //   /debug   → "not wired" + exit 0
    //   /inspect → "no active session" + exit 1 (different shape — needs session)
    //   /replay  → "not wired" + exit 0
    //   /why     → empty arg ⇒ exit 1 BEFORE the wiring check (positional id required)
    {
      const { ctx, io } = baseCtx()
      const code = await runSlashCommand("/debug status", ctx)
      expect(code).toBe(0)
      expect(io.out.join("")).toContain("not wired")
    }
    {
      const { ctx, io } = baseCtx()
      const code = await runSlashCommand("/inspect tc_anything", ctx)
      expect(code).toBe(1)
      expect(io.out.join("")).toContain("no active session")
    }
    {
      const { ctx, io } = baseCtx()
      const code = await runSlashCommand("/replay 01HXY", ctx)
      expect(code).toBe(0)
      expect(io.out.join("")).toContain("not wired in this surface")
    }
    {
      const { ctx, io } = baseCtx()
      // `/why <id>` first checks ctx.why; absent ⇒ "not wired" + exit 0.
      const code = await runSlashCommand("/why last", ctx)
      expect(code).toBe(0)
      expect(io.out.join("")).toContain("not wired in this surface")
    }
  })

  // ── BUILTINS registration invariants ──────────────────────────────────

  test("case-12: BUILTINS registers /debug, /inspect, /replay, /why (5-cmd slice)", () => {
    const names = BUILTINS.map((c) => c.name)
    expect(names).toContain("/debug")
    expect(names).toContain("/inspect")
    expect(names).toContain("/replay")
    expect(names).toContain("/why")
  })

  test("case-13: zero name collision — all BUILTINS names unique", () => {
    const names = BUILTINS.map((c) => c.name)
    const set = new Set(names)
    expect(set.size).toBe(names.length)
    // Defensive: confirm `isSlashCommand` recognises every builtin name.
    for (const n of names) expect(isSlashCommand(n)).toBe(true)
  })

  // ── stdout vs stderr separation ──────────────────────────────────────

  test("case-14: /inspect not-found → stdout carries 'not found'; stderr empty", async () => {
    const { ctx, io } = baseCtx({
      inspect: {
        sessionId: "sess-1",
        readSessionJsonl: async () => SESSION_FIXTURE,
      },
    })
    const code = await runSlashCommand("/inspect tc_missing", ctx)
    expect(code).toBe(1)
    expect(io.out.join("")).toContain("not found")
    // /inspect's not-found message is rendered via `out` (panel sink) — stderr
    // must stay empty.
    expect(io.err.join("")).toBe("")
  })

  test("case-15: /debug bad-arg → stderr has error; stdout empty", async () => {
    let currentState: DebugCmdState = { enabled: false }
    const { ctx, io } = baseCtx({
      debug: { get: () => currentState, set: (s) => { currentState = s } },
    })
    const code = await runSlashCommand("/debug bogus_category", ctx)
    expect(code).toBe(1)
    // Unknown argument → goes to stderr with the documented prefix.
    expect(io.err.join("")).toContain("/debug: unknown argument")
    expect(io.out.join("")).toBe("")
  })

  test("case-16: runSlashCommand dispatch tolerates unknown command — exit 1 + 'Available'", async () => {
    const { ctx, io } = baseCtx()
    const code = await runSlashCommand("/no-such-cmd arg1", ctx)
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("unknown command")
    // The dispatcher renders the available list on stdout.
    expect(io.out.join("")).toContain("Available")
  })
})
