/**
 * Permission-mode LIVE proxy — end-to-end behavior (jun-10 web mode-switch).
 *
 * The web daemon bakes `permission: { mode: "default" }` as a FIXED scalar, so a
 * mid-session permission switch was a LYING control (the gate kept reading the
 * baked value). The CLI/bootstrap path avoids this by making `permission.mode` a
 * LIVE getter/setter proxy over a mutable cell (`bootstrap-session.ts:302-309`),
 * which the per-turn gate re-reads. This test pins the BEHAVIOR the web daemon
 * must inherit: a mutating tool ASKS under `default` and AUTO-RUNS under
 * `bypass`, and flipping the cell BETWEEN turns is honored by the gate WITHOUT
 * rebuilding the session — proving the proxy is read live, not captured once.
 *
 * Deterministic: scripted fake LLM, no network. Mirrors tests/integration/
 * skill-scope-e2e.test.ts's harness.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { type AgentConfig, runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { PermissionContext, PermissionMode } from "@/permission"
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
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const toolUseScript = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]
const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** A MUTATING counting tool (isReadOnly false ⇒ the permission gate asks under
 *  `default`, auto-allows under `bypass`). */
const mutatingTool = (name: string, counts: Record<string, number>): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(): AsyncIterable<ToolEvent> {
    counts[name] = (counts[name] ?? 0) + 1
    yield { type: "result", result: { ok: true, output: `${name} ran` } }
  },
})

/** A mutable permission cell exposed as a LIVE proxy — the exact shape
 *  `bootstrap-session.ts` builds. `.mode` reads/writes the cell, so a per-turn
 *  reader observes the latest value. */
const liveProxyPermission = (
  initial: PermissionMode,
): {
  permission: PermissionContext
  set: (m: PermissionMode) => void
  get: () => PermissionMode
} => {
  let mode: PermissionMode = initial
  return {
    permission: {
      get mode() {
        return mode
      },
      set mode(next: PermissionMode) {
        mode = next
      },
    },
    set: (m) => {
      mode = m
    },
    get: () => mode,
  }
}

const baseConfig = (
  llm: LLMPort,
  registry: ToolRegistry,
  stream: StreamPort,
  permission: PermissionContext,
  onConfirm: AgentConfig["onConfirm"],
): AgentConfig => ({
  llm,
  registry,
  stream,
  permission,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test",
  cwd: "/tmp",
  maxTurns: 6,
  signal: new AbortController().signal,
  ...(onConfirm !== undefined ? { onConfirm } : {}),
})

describe("permission-mode live proxy (e2e behavior)", () => {
  test("a mutating tool ASKS under default and AUTO-RUNS under bypass — flip between turns is honored LIVE", async () => {
    const proxy = liveProxyPermission("default")
    const counts: Record<string, number> = {}
    const registry = new ToolRegistry([mutatingTool("danger", counts)])

    // ── Turn 1: mode = default ⇒ the mutating tool ASKS (onConfirm fires). We
    //    DENY so it does not run, proving the gate gated it.
    let asked1 = 0
    const llm1 = new FakeLLM([toolUseScript("d1", "danger", {}), textScript("done")])
    const out1 = await runAgent(
      baseConfig(llm1, registry, new RecordingStream(), proxy.permission, async () => {
        asked1 += 1
        return false // deny
      }),
    )
    expect(out1.reason).toBe("completed")
    expect(asked1).toBe(1) // default ⇒ asked
    expect(counts.danger).toBeUndefined() // denied ⇒ never ran

    // ── Flip the SAME proxy to bypass (no session rebuild). ──
    proxy.set("bypass")
    expect(proxy.get()).toBe("bypass")

    // ── Turn 2: mode = bypass ⇒ the SAME tool AUTO-RUNS (onConfirm NOT fired). ──
    let asked2 = 0
    const llm2 = new FakeLLM([toolUseScript("d2", "danger", {}), textScript("done")])
    const out2 = await runAgent(
      baseConfig(llm2, registry, new RecordingStream(), proxy.permission, async () => {
        asked2 += 1
        return false
      }),
    )
    expect(out2.reason).toBe("completed")
    expect(asked2).toBe(0) // bypass ⇒ NOT asked — the live flip was honored
    expect(counts.danger).toBe(1) // auto-ran exactly once
  })
})
