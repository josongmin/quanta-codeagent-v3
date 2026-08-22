/**
 * Ticket P2-T1 (always-confirm secure-by-default) — UN-BLOCKED by P2-T3 (PDP
 * capability spec). A tool that declares `capability.confirm: "sensitive"` joins
 * the UNIVERSAL always-confirm floor: confirmed on EVERY surface, even under
 * bypass, even without the HITL opt-in. A `needs-sandbox` tool (e.g. bash without
 * a profile) DEFERS — that is what keeps the ~89 shell tests from being gated.
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
/** Inherently-sensitive (e.g. git push / deploy): declares the capability ⇒
 *  joins the UNIVERSAL floor. */
const alwaysConfirmTool = (counts: { n: number }): Tool => ({
  name: "deployer",
  description: "deployer",
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "always-confirm",
  capability: () => ({ confirm: "sensitive" }),
  async *execute(): AsyncIterable<ToolEvent> {
    counts.n += 1
    yield { type: "result", result: { ok: true, output: "ran" } }
  },
})

/** needs-sandbox (e.g. bash without a profile): always-confirm tier but NOT
 *  inherently sensitive ⇒ DEFERS (not gated by the universal floor). */
const needsSandboxTool = (counts: { n: number }): Tool => ({
  name: "sh",
  description: "sh",
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "always-confirm",
  capability: () => ({ confirm: "needs-sandbox" }),
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
  toolName?: string
}): AgentConfig => ({
  llm: new FakeLLM([callTool("a1", args.toolName ?? "deployer"), endText]),
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

describe("always-confirm — UNIVERSAL floor (secure-by-default) [P2-T1]", () => {
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
      cfg({
        registry: new ToolRegistry([alwaysConfirmTool(counts)]),
        permission: { mode: "bypass" },
      }),
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

  // THE split that un-blocks T1 without gating bash: a `needs-sandbox`
  // always-confirm tool is NOT promoted to the universal floor. With HITL not
  // opted in it DEFERS to mode policy — under bypass it auto-runs (no ask). This
  // is exactly why the ~89 shell tests do not break.
  test("needs-sandbox always-confirm tool DEFERS (auto-runs under bypass, not universally gated)", async () => {
    const counts = { n: 0 }
    let asked = 0
    await runAgent(
      cfg({
        registry: new ToolRegistry([needsSandboxTool(counts)]),
        toolName: "sh",
        permission: { mode: "bypass" },
        onConfirm: async () => {
          asked += 1
          return false
        },
      }),
    )
    expect(asked).toBe(0) // never asked — deferred to mode policy
    expect(counts.n).toBe(1) // auto-ran under bypass (NOT gated by the floor)
  })

  // END-TO-END with the REAL git_push tool through runAgent (the user-facing
  // path): under bypass, the model calls git_push → the loop dispatches → the
  // floor fires the confirm modal (onConfirm) → a decline BLOCKS the push. The
  // git runner throws if ever reached, proving the tool body never ran.
  test("REAL git_push under bypass fires the confirm modal and a decline blocks it", async () => {
    const { gitPushTool } = await import("@/tool/git")
    let modalShown = 0
    const push = gitPushTool((() => {
      throw new Error("git push must not run without confirmation")
    }) as never)
    const out = await runAgent({
      llm: new FakeLLM([callTool("p1", "git_push"), endText]),
      registry: new ToolRegistry([push]),
      stream: new RecordingStream(),
      permission: { mode: "bypass" },
      messages: [{ role: "user", content: [{ type: "text", text: "push it" }] }] as Message[],
      system: "test",
      cwd: "/tmp",
      maxTurns: 4,
      signal: new AbortController().signal,
      onConfirm: async () => {
        modalShown += 1
        return false // operator declines at the modal
      },
    })
    expect(out.reason).toBe("completed")
    expect(modalShown).toBe(1) // the modal was shown EVEN under bypass
  })

  // REGRESSION GUARD (the 89-breakage): a plain always-confirm tool with NO
  // capability (the inferToolTier catch-all — every unclassified mutating tool,
  // bash included) DEFERS. If the floor ever widens to catch these, the whole
  // shell-tool suite breaks again — this flips RED first.
  test("capability-LESS always-confirm tool DEFERS under bypass (no over-gating)", async () => {
    const counts = { n: 0 }
    let asked = 0
    const plain: Tool = {
      name: "plainac",
      description: "plainac",
      inputSchema: z.object({}).passthrough(),
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      hitlTier: () => "always-confirm", // tier present, capability absent
      async *execute(): AsyncIterable<ToolEvent> {
        counts.n += 1
        yield { type: "result", result: { ok: true, output: "ran" } }
      },
    }
    await runAgent(
      cfg({
        registry: new ToolRegistry([plain]),
        toolName: "plainac",
        permission: { mode: "bypass" },
        onConfirm: async () => {
          asked += 1
          return false
        },
      }),
    )
    expect(asked).toBe(0) // never asked — capability-less defers
    expect(counts.n).toBe(1) // auto-ran (mode policy), NOT gated by the floor
  })
})
