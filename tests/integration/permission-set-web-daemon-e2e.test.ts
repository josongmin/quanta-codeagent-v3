/**
 * `session.permission.set` end-to-end through the WEB DAEMON runtime path
 * (jun-10). Proves the FULL wire — `session.permission.set` command → kernel
 * reducer/scheduler → `host.setPermissionMode` → the live `permission.mode`
 * proxy → the NEXT turn's gate honors it — using the SAME runtime the daemon
 * builds (`createRuntimeFromAgentConfigBase` + `buildInteractiveTurnAssembler`).
 *
 * This is the behavior the reverted "lying lever" lacked: setting bypass MUST
 * make a mutating tool that was gated under `default` actually AUTO-RUN. A
 * display-only echo would leave the gate reading the baked mode and the tool
 * stays gated — so this test fails RED on any non-honored wiring.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import { StdoutStream } from "@/stream"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"
import { z } from "zod"

/** A scripted LLM: turn 1 calls the mutating tool; turn 2 calls it again; then
 *  ends. (Each `stream()` call serves the next script.) */
class ScriptedLLM implements LLMPort {
  readonly model = "stub"
  private readonly scripts: StreamEvent[][]
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    for (const ev of this.scripts.shift() ?? [{ type: "message_stop", stop_reason: "end_turn" }])
      yield ev
  }
}

const callTool = (id: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "danger" },
  { type: "tool_use_end", id, input: {} },
  { type: "message_stop", stop_reason: "tool_use" },
]
const endText: StreamEvent[] = [
  { type: "text_delta", delta: "ok" },
  { type: "message_stop", stop_reason: "end_turn" },
]

const mutatingTool = (counts: { n: number }): Tool => ({
  name: "danger",
  description: "danger",
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  // pre-approval-ok = the ordinary mutating-tool tier: mode policy decides
  // (default asks, bypass auto-runs). Explicit so the web daemon's HITL gate
  // (now enabled) doesn't conservatively treat it as always-confirm.
  hitlTier: () => "pre-approval-ok",
  async *execute(): AsyncIterable<ToolEvent> {
    counts.n += 1
    yield { type: "result", result: { ok: true, output: "ran" } }
  },
})

/** The web daemon's live permission proxy (runtime-factory.ts). */
const liveProxy = (): PermissionContext => {
  let mode: PermissionContext["mode"] = "default"
  return {
    get mode() {
      return mode
    },
    set mode(next) {
      mode = next
    },
  }
}

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

describe("session.permission.set — web-daemon runtime e2e", () => {
  test("setting bypass mid-session makes a default-gated mutating tool AUTO-RUN on the next turn", async () => {
    const abort = new AbortController()
    const counts = { n: 0 }
    const permission = liveProxy()
    const base = {
      // Turn 1 = [call danger → (denied) → end]; Turn 2 = [call danger → (auto) → end].
      llm: new ScriptedLLM([callTool("t1"), endText, callTool("t2"), endText]),
      registry: new ToolRegistry([mutatingTool(counts)]),
      stream: new StdoutStream(),
      permission,
      messages: [],
      system: "system",
      cwd: "/tmp/quanta-web-perm",
      maxTurns: 4,
      signal: abort.signal,
      hitl: { enabled: true }, // mirror the web daemon's security config
      // Deny when asked (default mode asks for a mutating tool) so turn 1
      // COMPLETES (no suspend) with the tool gated-out.
      onConfirm: async () => false,
    }
    const { runtime } = await createRuntimeFromAgentConfigBase({
      base,
      turnAssembler: buildInteractiveTurnAssembler(),
      history: [],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })
    const session = await runtime.createSession({ cwd: base.cwd, permissionMode: "default" })
    cleanup = async () => {
      await session.close()
      await runtime.close()
    }

    // ── Turn 1 — default: the mutating tool is gated (onConfirm denies) ⇒ never runs.
    await session.input.append("go")
    await session.turn.run()
    expect(counts.n).toBe(0)
    expect((await session.snapshot()).state.permissionMode).toBe("default")

    // ── Flip to bypass via the SESSION VERB (the real path). ──
    await session.permission.set("bypass")
    expect((await session.snapshot()).state.permissionMode).toBe("bypass")
    expect(permission.mode).toBe("bypass") // host.setPermissionMode mutated the live proxy

    // ── Turn 2 — bypass: the SAME tool now AUTO-RUNS (gate honored the live switch). ──
    await session.input.append("again")
    await session.turn.run()
    expect(counts.n).toBe(1)

    // ── Fail-closed: an UNKNOWN mode is IGNORED by the host (it would make
    //    `modePolicy[mode]` undefined). The live proxy stays at the last valid
    //    value, so the gate is never poisoned by a malformed client. ──
    await session.permission.set("nonsense-mode")
    expect((await session.snapshot()).state.permissionMode).toBe("bypass")
    expect(permission.mode).toBe("bypass")
  })
})
