/**
 * `hand-off-required` is a UNIVERSAL security floor (jun-10 keystone).
 *
 * Audit finding (jun-10 permission-architecture-audit §F1): the HITL tier gate
 * is surface-OPT-IN (`config.hitl.enabled`) — only the web daemon sets it. So on
 * every other surface (CLI / agent / bench), a `hand-off-required` tool — the
 * tier whose contract is "NO mode can authorize" — would fall through to mode
 * policy and AUTO-RUN under `bypass`. That is a default-OPEN hole in the hardest
 * boundary there is.
 *
 * The fix elevates `hand-off-required ⇒ DENY` to the same UNIVERSAL status as
 * HARD_DENY: enforced regardless of the opt-in flag, on every surface, under
 * every mode, even when the operator's `onConfirm` would approve. This pins that
 * invariant with a runtime that does NOT opt into HITL (the bare default).
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { type AgentConfig, runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"

class FakeLLM implements LLMPort {
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(): AsyncIterable<StreamEvent> {
    const next = this.scripts.shift()
    if (next) this.last = next
    for (const ev of next ?? this.last) yield ev
  }
}
class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(e: AgentEvent): void {
    this.events.push(e)
  }
}
const callTool = (id: string, name: string): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input: {} },
  { type: "message_stop", stop_reason: "tool_use" },
]
const endText: StreamEvent[] = [
  { type: "text_delta", delta: "ok" },
  { type: "message_stop", stop_reason: "end_turn" },
]
const tieredTool = (
  name: string,
  counts: { n: number },
  tier: "hand-off-required" | "always-confirm",
): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => tier,
  async *execute(): AsyncIterable<ToolEvent> {
    counts.n += 1
    yield { type: "result", result: { ok: true, output: "ran" } }
  },
})
const handoffTool = (counts: { n: number }): Tool =>
  tieredTool("destroyer", counts, "hand-off-required")
const cfg = (
  llm: LLMPort,
  registry: ToolRegistry,
  stream: StreamPort,
  permission: PermissionContext,
  onConfirm: AgentConfig["onConfirm"],
  hitl = false,
): AgentConfig => ({
  llm,
  registry,
  stream,
  permission,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test",
  cwd: "/tmp",
  maxTurns: 4,
  signal: new AbortController().signal,
  ...(onConfirm !== undefined ? { onConfirm } : {}),
  ...(hitl ? { hitl: { enabled: true } } : {}),
})

describe("hand-off-required — UNIVERSAL deny (secure-by-default)", () => {
  test("a hand-off-required tool is DENIED with HITL NOT opted in, even under bypass + approving onConfirm", async () => {
    const counts = { n: 0 }
    let asked = 0
    const out = await runAgent(
      cfg(
        new FakeLLM([callTool("x1", "destroyer"), endText]),
        new ToolRegistry([handoffTool(counts)]),
        new RecordingStream(),
        { mode: "bypass" }, // the most permissive mode
        async () => {
          asked += 1
          return true // even an APPROVING operator must not unlock it
        },
      ),
    )
    expect(out.reason).toBe("completed")
    expect(counts.n).toBe(0) // NEVER ran — universal hard boundary
    expect(asked).toBe(0) // hard-deny short-circuits the ask
    // The denial surfaces as a recoverable is_error tool_result (not a crash).
    const denied = out.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result" && b.tool_use_id === "x1")
    expect(denied?.type === "tool_result" ? denied.is_error : false).toBe(true)
  })

  test("a read-only tool is still allowed under the same bare config (no over-blocking)", async () => {
    const counts = { n: 0 }
    let asked = 0
    const ro: Tool = {
      name: "peek",
      description: "peek",
      inputSchema: z.object({}).passthrough(),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async *execute(): AsyncIterable<ToolEvent> {
        counts.n += 1
        yield { type: "result", result: { ok: true, output: "ran" } }
      },
    }
    await runAgent(
      cfg(
        new FakeLLM([callTool("r1", "peek"), endText]),
        new ToolRegistry([ro]),
        new RecordingStream(),
        { mode: "default" },
        async () => {
          asked += 1
          return true
        },
      ),
    )
    expect(counts.n).toBe(1) // ran
    expect(asked).toBe(0) // read-only never gated by the floor
  })

  // NOTE (jun-10): `always-confirm` secure-by-default is intentionally NOT
  // universalized here — `bash` without a sandbox profile self-reports
  // `always-confirm` for ALL commands, so a blanket flip would gate every shell
  // call on profile-less surfaces. That needs the sandbox-aware + autonomous
  // opt-out design (Phase-2). Only `hand-off-required` is universal below.

  // STRUCTURAL RATCHET — the invariant is EXHAUSTIVE: across EVERY mode × HITL
  // opt-in × operator decision, a hand-off-required tool NEVER runs. If any
  // future change opens a path (a new mode, a config that relaxes it), one of
  // these cells flips RED. This is the fence that keeps the floor universal.
  const MODES = ["default", "acceptEdits", "bypass", "auto"] as const
  for (const mode of MODES) {
    for (const hitl of [false, true]) {
      for (const approve of [false, true]) {
        test(`matrix: mode=${mode} hitl=${hitl} onConfirm=${approve ? "approve" : "deny"} ⇒ hand-off NEVER runs`, async () => {
          const counts = { n: 0 }
          await runAgent(
            cfg(
              new FakeLLM([callTool("m1", "destroyer"), endText]),
              new ToolRegistry([handoffTool(counts)]),
              new RecordingStream(),
              { mode },
              async () => approve,
              hitl,
            ),
          )
          expect(counts.n).toBe(0)
        })
      }
    }
  }
})
