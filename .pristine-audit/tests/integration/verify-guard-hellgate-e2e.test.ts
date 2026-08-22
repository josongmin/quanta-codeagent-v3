import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import { VERIFY_FORCE_MESSAGE } from "@/agent/verify-guard"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { type Tool, ToolRegistry } from "@/tool"

/**
 * D5 HELLGATE (e2e) — the FLAGSHIP false-success DENY net through the REAL
 * `runAgent` loop. This is the headline proof:
 *
 *   "git status does NOT satisfy the gate; a real pytest DOES."
 *
 * We drive the loop with a scripted fake LLM and deterministic stub tools (no
 * fs / no exec). The proof is structural: a finish attempt that follows ONLY a
 * lying command after an edit causes an EXTRA forced turn (more LLM calls /
 * turns than the naive count), the `VERIFY_FORCE_MESSAGE` is injected, and the
 * run only completes once a REAL test command runs.
 *
 * Mirrors the existing `verify-guard-e2e.test.ts` harness verbatim so it
 * targets the same live loop wiring.
 */

type Step = { kind: "events"; events: StreamEvent[] }

class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  private readonly steps: Step[]
  constructor(steps: Step[]) {
    this.steps = steps
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const step = this.steps.shift() ?? this.steps[this.steps.length - 1]
    if (!step) throw new Error("script exhausted")
    for (const ev of step.events) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
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

const ev = (events: StreamEvent[]): Step => ({ kind: "events", events })

const dispatched: string[] = []
const stubTool = (name: string, readOnly: boolean): Tool => ({
  name,
  description: `stub ${name}`,
  // Concrete passthrough object (NOT z.any()): preserves every input field the
  // fake LLM sends (e.g. bash `command`, which the verify-guard gate inspects)
  // while producing a real object JSON-schema — so the flagship e2e never
  // depends on zodToJsonSchema tolerating ZodAny at registry-build time.
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => readOnly,
  isConcurrencySafe: () => readOnly,
  async *execute() {
    dispatched.push(name)
    yield { type: "result", result: { ok: true, output: `${name} ok` } }
  },
})

const stubRegistry = (): ToolRegistry =>
  new ToolRegistry([
    stubTool("read", true),
    stubTool("edit", false),
    stubTool("write", false),
    stubTool("test_runner", false),
    stubTool("bash", false),
  ])

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: stubRegistry(),
  stream: new RecordingStream(),
  permission: { mode: "bypass" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "fix the bug" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 8,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${label} did not terminate in ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const hasForcing = (messages: Message[]): boolean =>
  messages.some(
    (m) =>
      m.role === "user" &&
      m.content.some((b) => b.type === "text" && b.text === VERIFY_FORCE_MESSAGE),
  )

const forcingCount = (messages: Message[]): number =>
  messages.filter(
    (m) =>
      m.role === "user" &&
      m.content.some((b) => b.type === "text" && b.text === VERIFY_FORCE_MESSAGE),
  ).length

const toolUseSequence = (messages: Message[]): string[] =>
  messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => b.name))

describe("D5 HELLGATE e2e — git status does NOT satisfy / real pytest DOES", () => {
  test("HEADLINE: edit → ONLY `git status` → finish ⇒ EXTRA forced turn, completes only after a real pytest", async () => {
    dispatched.length = 0
    const stream = new RecordingStream()
    // Naive (un-guarded) path would finish at call 3 (after git status).
    // The guard must force one more turn; the run completes only once a real
    // pytest runs.
    const llm = new ScriptedLLM([
      ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })),
      ev(toolUse("b1", "bash", { command: "git status" })),
      ev(text("All done, fix is complete.")), // lying finish — MUST be forced
      ev(toolUse("b2", "bash", { command: "python -m pytest -q" })), // forced extra turn
      ev(text("Verified, done for real.")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, verifyGuard: { maxTrips: 2 }, maxTurns: 8 })),
      15_000,
      "headline-git-status-vs-pytest",
    )

    expect(out.reason).toBe("completed")
    // Naive count to first finish attempt = 3. The forced extra turn pushes it
    // strictly higher: edit + git-status + finish(forced) + pytest + finish = 5.
    expect(llm.calls).toBe(5)
    expect(llm.calls).toBeGreaterThan(3)
    expect(hasForcing(out.messages)).toBe(true)
    expect(forcingCount(out.messages)).toBe(1)
    // The real pytest is what released the gate; both bash calls dispatched.
    expect(toolUseSequence(out.messages)).toEqual(["edit", "bash", "bash"])
    expect(dispatched).toEqual(["edit", "bash", "bash"])
    expect(
      stream.events.filter((e) => e.type === "recovery" && e.reason === "unverified"),
    ).toHaveLength(1)
  })

  test("edit → no-op `echo done` → finish ⇒ STILL forced (echo is not verification)", async () => {
    dispatched.length = 0
    const llm = new ScriptedLLM([
      ev(toolUse("e1", "edit", { path: "/x.ts" })),
      ev(toolUse("b1", "bash", { command: "echo done" })),
      ev(text("Looks done.")), // lying finish — forced
      ev(toolUse("b2", "bash", { command: "pytest" })),
      ev(text("Now actually done.")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, verifyGuard: { maxTrips: 2 }, maxTurns: 8 })),
      15_000,
      "echo-still-forces",
    )
    expect(out.reason).toBe("completed")
    expect(llm.calls).toBe(5)
    expect(hasForcing(out.messages)).toBe(true)
    expect(dispatched).toEqual(["edit", "bash", "bash"])
  })

  test("pure read-only session (no mutation) ⇒ gate does NOT force (no false positive)", async () => {
    dispatched.length = 0
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      ev(toolUse("r1", "read", { path: "/a.ts" })),
      ev(toolUse("b1", "bash", { command: "git status" })), // noise, but no edit happened
      ev(text("No changes needed.")),
      ev(text("must NOT be reached")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, verifyGuard: { maxTrips: 2 }, maxTurns: 8 })),
      15_000,
      "read-only-no-force",
    )
    expect(out.reason).toBe("completed")
    expect(llm.calls).toBe(3) // no forced extra turn
    expect(hasForcing(out.messages)).toBe(false)
    expect(
      stream.events.filter((e) => e.type === "recovery" && e.reason === "unverified"),
    ).toHaveLength(0)
    expect(dispatched).toEqual(["read", "bash"])
  })

  test("multiple edits then a SINGLE real test ⇒ satisfied once (not N times)", async () => {
    dispatched.length = 0
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      ev(toolUse("e1", "edit", { path: "/a.ts" })),
      ev(toolUse("e2", "edit", { path: "/b.ts" })),
      ev(toolUse("e3", "edit", { path: "/c.ts" })),
      ev(toolUse("t1", "test_runner", { suite: "all" })),
      ev(text("All edits verified by one run.")),
      ev(text("must NOT be reached")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, verifyGuard: { maxTrips: 2 }, maxTurns: 8 })),
      15_000,
      "multi-edit-one-verify",
    )
    expect(out.reason).toBe("completed")
    // 3 edits + 1 test + 1 finish = 5, NO forcing (single verify covers all).
    expect(llm.calls).toBe(5)
    expect(hasForcing(out.messages)).toBe(false)
    expect(forcingCount(out.messages)).toBe(0)
    expect(
      stream.events.filter((e) => e.type === "recovery" && e.reason === "unverified"),
    ).toHaveLength(0)
    expect(dispatched).toEqual(["edit", "edit", "edit", "test_runner"])
  })
})
