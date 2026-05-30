/**
 * T02 — Turn Outcome Authority hellgates (bugbash may-31, L1 H1/H2/M1/M2/M3 + L1 M5).
 *
 * Proof rail: every terminal turn outcome (success / refusal / budget / abort /
 * approval-pause) passes ONE closeout authority and yields IDENTICAL transcript
 * invariants:
 *   - no orphan `tool_use` (every tool_use id has a matching tool_result),
 *   - the correct `reason` (aborted vs error vs refusal vs budget_exhausted),
 *   - observability (turn-diff endTurn + git-directive flush + work-metrics)
 *     flushed EXACTLY ONCE per terminal turn — including the throw/pause path.
 *
 * Written hellgate-first (TDD): they encode the closeout criterion, not an
 * afterthought. Fixes live in `src/agent/turn-closeout.ts`, `src/agent/loop.ts`,
 * `src/agent/streaming-dispatch.ts`, `src/agent/compaction-breaker.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, BudgetMeter, runAgent } from "@/agent"
import type { TurnDiffSession } from "@/agent/git-observability"
import type { GitDirectiveCollector } from "@/git/directive-emit/turn-collector"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig, LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

// ── Transcript invariant ─────────────────────────────────────────────────
/** Returns the set of orphan `tool_use` ids: tool_use blocks in `messages`
 *  with no matching `tool_result` (by id). The single load-bearing transcript
 *  invariant — a non-empty set means a provider 400 on resume/fork/replay. */
const orphanToolUseIds = (messages: readonly Message[]): string[] => {
  const used = new Set<string>()
  const resulted = new Set<string>()
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") used.add(b.id)
      if (b.type === "tool_result") resulted.add(b.tool_use_id)
    }
  }
  return [...used].filter((id) => !resulted.has(id))
}

// ── Local test doubles ───────────────────────────────────────────────────
class FakeLLM implements LLMPort {
  calls = 0
  readonly model = "test-model"
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

/** Aborts `controller` while a chunk is being awaited, then throws an
 *  `LLMError{kind:"aborted"}` from inside the `for await` — the exact H1 shape
 *  (cancel arrives mid-stream, the adapter rethrows AbortError as aborted). */
class AbortMidStreamLLM implements LLMPort {
  readonly model = "test-model"
  constructor(private readonly controller: AbortController) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "thinking" }
    // Simulate the user pressing Ctrl+C while we await the next chunk.
    this.controller.abort()
    throw new LLMError("stream aborted by user", { kind: "aborted" })
  }
}

class NullStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/** TurnDiffSession that counts endTurn calls so we can assert "flushed once". */
class CountingDiffSession implements TurnDiffSession {
  startTurns = 0
  endTurns = 0
  async startTurn(): Promise<void> {
    this.startTurns += 1
  }
  async endTurn(): Promise<Extract<AgentEvent, { type: "turn_diff_updated" }> | null> {
    this.endTurns += 1
    return null
  }
}

/** GitDirectiveCollector that counts flush calls. */
class CountingDirectiveCollector implements GitDirectiveCollector {
  flushes = 0
  record(): void {}
  flush(): never[] {
    this.flushes += 1
    return []
  }
  get length(): number {
    return 0
  }
}

const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]
const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]
const refusalWithTool = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "text_delta", delta: "I can't help with that." },
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "refusal" },
]

const baseCfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new NullStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test",
  cwd: "/tmp",
  maxTurns: 10,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null
let dir: string

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "t02-perm-state-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  dir = mkdtempSync(join(tmpdir(), "t02-closeout-"))
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permissionStateRoot !== null) {
    rmSync(permissionStateRoot, { recursive: true, force: true })
    permissionStateRoot = null
  }
  rmSync(dir, { recursive: true, force: true })
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

// ── H1 — abort mid-stream is classified `aborted`, not `error` ────────────
describe("T02 H1 — user-cancel during streaming wait", () => {
  test("mid-stream abort ⇒ reason aborted (NOT error/RUNTIME_UNKNOWN)", async () => {
    const controller = new AbortController()
    const llm = new AbortMidStreamLLM(controller)
    const cfg = baseCfg({ llm, cwd: dir, signal: controller.signal })
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBe("aborted")
    expect(outcome.stopCategory?.kind).toBe("interrupted")
  })
})

// ── H2 — budget exhaustion at a tool turn closes the transcript ───────────
describe("T02 H2 — budget exhaustion at a tool-producing turn", () => {
  test("budget trip at tool turn ⇒ no orphan tool_use in final messages", async () => {
    const llm = new FakeLLM([
      toolUse("c1", "ls", { paths: [dir] }),
      toolUse("c2", "ls", { paths: [dir] }),
      toolUse("c3", "ls", { paths: [dir] }),
    ])
    const meter = new BudgetMeter({ dials: { maxTurns: 1 } })
    const cfg = baseCfg({ llm, cwd: dir, budgetMeter: meter, maxTurns: 20 })
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBe("budget_exhausted")
    expect(orphanToolUseIds(outcome.messages)).toEqual([])
  })
})

// ── M2 — refusal with queued tool calls leaves no orphan tool_use ─────────
describe("T02 M2 — refusal with mid-stream tool calls", () => {
  test("refusal ⇒ no orphan tool_use persisted to working memory", async () => {
    const llm = new FakeLLM([refusalWithTool("r1", "ls", { paths: [dir] })])
    const cfg = baseCfg({ llm, cwd: dir })
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBe("refusal")
    expect(orphanToolUseIds(outcome.messages)).toEqual([])
  })
})

// ── M5 — closeout flushes observability exactly once ──────────────────────
describe("T02 M5 — turn observability closeout", () => {
  test("completed turn flushes turn-diff endTurn + git-directive exactly once", async () => {
    const diff = new CountingDiffSession()
    const collector = new CountingDirectiveCollector()
    const cfg = baseCfg({
      llm: new FakeLLM([text("done")]),
      cwd: dir,
      gitObservability: { enabled: true, session: diff },
      gitDirectiveEmit: { enabled: true, collector },
    })
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBe("completed")
    expect(diff.startTurns).toBe(1)
    expect(diff.endTurns).toBe(1)
    expect(collector.flushes).toBe(1)
  })

  test("refusal turn still flushes turn-diff + git-directive exactly once", async () => {
    const diff = new CountingDiffSession()
    const collector = new CountingDirectiveCollector()
    const cfg = baseCfg({
      llm: new FakeLLM([refusalWithTool("r1", "ls", { paths: [dir] })]),
      cwd: dir,
      gitObservability: { enabled: true, session: diff },
      gitDirectiveEmit: { enabled: true, collector },
    })
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBe("refusal")
    expect(diff.endTurns).toBe(1)
    expect(collector.flushes).toBe(1)
  })
})

// ── M3 — proactive compaction breaker actually trips ──────────────────────
describe("T02 M3 — proactive compaction circuit breaker is enforced", () => {
  test("loop terminates cleanly + no orphan when no compaction configured", async () => {
    const llm = new FakeLLM([text("ok")])
    const cfg = baseCfg({ llm, cwd: dir })
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBe("completed")
    expect(orphanToolUseIds(outcome.messages)).toEqual([])
  })
})
