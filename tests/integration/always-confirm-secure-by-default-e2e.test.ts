/**
 * ⚠️ AGENTS: SKIPPED ON PURPOSE — this is the TARGET hellgate for ticket P2-T1
 * (always-confirm secure-by-default), BLOCKED on P2-T3. Do NOT delete it and do
 * NOT un-skip it with a naive gate flip.
 *
 * WHY BLOCKED: universalizing always-confirm at the admissibility-gate level
 * breaks ~89 integration tests because `bash` without a sandbox profile
 * self-reports `always-confirm` for ALL commands ("needs-sandbox"), which the
 * tier cannot distinguish from an inherently-sensitive tool (git push). The real
 * fix needs the capability-spec (P2-T3 PDP/PEP) to split those two reasons so
 * only inherently-sensitive tools get the universal floor while bash defers to
 * its sandbox profile. The `hitl.autoApprove` opt-out (used below) is the
 * autonomous escape hatch that ships with that work. Un-skip when T3 lands.
 *
 * Ticket P2-T1 — `always-confirm` is a UNIVERSAL security floor (jun-10 Phase-2).
 *
 * Today `always-confirm` enforcement is OPT-IN (`config.hitl.enabled`), so on a
 * surface that never opts in, an always-confirm tool (git push / deploy /
 * code-exec, AND `bash` without a sandbox profile, which self-reports
 * always-confirm for ALL commands) AUTO-RUNS under bypass — the touchpoint is
 * silently skipped. This ticket makes the floor UNIVERSAL: enforced regardless
 * of the opt-in flag, with one explicit escape hatch — `hitl.autoApprove` — for
 * AUTONOMOUS surfaces (bench / headless / CI) that accept the risk of running
 * always-confirm tools unattended.
 *
 *   interactive (real onConfirm), no HITL opt-in, bypass  ⇒ STILL asked
 *   no asker at all,                       bypass          ⇒ fail-closed DENY
 *   autoApprove surface,                   bypass          ⇒ auto-run (opt-out)
 *
 * hand-off-required (already universal, see hand-off-required-universal-e2e)
 * is NEVER opted out, even by autoApprove.
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
const alwaysConfirmTool = (counts: { n: number }): Tool => ({
  name: "deployer",
  description: "deployer",
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "always-confirm",
  async *execute(): AsyncIterable<ToolEvent> {
    counts.n += 1
    yield { type: "result", result: { ok: true, output: "ran" } }
  },
})
const cfg = (args: {
  registry: ToolRegistry
  permission: PermissionContext
  onConfirm?: AgentConfig["onConfirm"]
  hitl?: AgentConfig["hitl"]
}): AgentConfig => ({
  llm: new FakeLLM([callTool("a1", "deployer"), endText]),
  registry: args.registry,
  stream: new RecordingStream(),
  permission: args.permission,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test",
  cwd: "/tmp",
  maxTurns: 4,
  signal: new AbortController().signal,
  ...(args.onConfirm !== undefined ? { onConfirm: args.onConfirm } : {}),
  ...(args.hitl !== undefined ? { hitl: args.hitl } : {}),
})

describe.skip("always-confirm — UNIVERSAL floor (secure-by-default) [P2-T1, BLOCKED on T3]", () => {
  test("interactive surface is ASKED for an always-confirm tool under bypass with HITL NOT opted in", async () => {
    const counts = { n: 0 }
    let asked = 0
    await runAgent(
      cfg({
        registry: new ToolRegistry([alwaysConfirmTool(counts)]),
        permission: { mode: "bypass" },
        onConfirm: async () => {
          asked += 1
          return false
        },
      }),
    )
    expect(asked).toBe(1) // STILL asked — always-confirm not relaxed by bypass
    expect(counts.n).toBe(0) // declined ⇒ did not run
  })

  test("no asker at all ⇒ always-confirm fail-closed DENIES under bypass (no HITL opt-in)", async () => {
    const counts = { n: 0 }
    const out = await runAgent(
      cfg({ registry: new ToolRegistry([alwaysConfirmTool(counts)]), permission: { mode: "bypass" } }),
    )
    expect(out.reason).toBe("completed")
    expect(counts.n).toBe(0) // fail-closed — never ran
  })

  test("hitl.autoApprove (autonomous opt-out) auto-runs always-confirm UNATTENDED without asking", async () => {
    const counts = { n: 0 }
    let asked = 0
    await runAgent(
      cfg({
        registry: new ToolRegistry([alwaysConfirmTool(counts)]),
        permission: { mode: "acceptEdits" },
        onConfirm: async () => {
          asked += 1
          return false
        },
        hitl: { autoApprove: true },
      }),
    )
    expect(asked).toBe(0) // never asked — autonomous opt-out
    expect(counts.n).toBe(1) // auto-ran
  })
})
