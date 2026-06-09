/**
 * Permission-mode switch — ADVERSARIAL e2e (jun-10). Permission is security
 * critical, so this suite stresses the `session.permission.set` switch against
 * the cases that matter: a `bypass` switch MUST NOT escalate past the HARD
 * security boundaries, MUST be reversible, MUST persist, and MUST fail closed.
 *
 * All cases drive the SAME runtime the web daemon builds
 * (`createRuntimeFromAgentConfigBase` + `buildInteractiveTurnAssembler`) through
 * the real verb (`session.permission.set`), so a regression in the live-proxy
 * wiring fails RED here.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { HITLTier } from "@/shared"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import { StdoutStream } from "@/stream"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"

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

/** Scripts for ONE turn that calls `tool` once then ends (the loop calls the LLM
 *  again after the tool result, hence two scripts per turn). */
const turnCalling = (tool: string, id: string): StreamEvent[][] => [
  [
    { type: "tool_use_start", id, name: tool },
    { type: "tool_use_end", id, input: {} },
    { type: "message_stop", stop_reason: "tool_use" },
  ],
  [
    { type: "text_delta", delta: "ok" },
    { type: "message_stop", stop_reason: "end_turn" },
  ],
]

/** A mutating tool. Defaults to the `pre-approval-ok` tier (the realistic tier
 *  for an ordinary write/edit/bash-class tool: mode policy decides — default
 *  asks, bypass auto-runs). Pass an explicit tier for the security boundaries. */
const tool = (name: string, counts: { n: number }, tier: HITLTier = "pre-approval-ok"): Tool => ({
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

/** A read-only tool ⇒ inferred tier `none` ⇒ allowed in every mode without an ask. */
const readOnlyTool = (name: string, counts: { n: number }): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
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

let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

const harness = async (args: {
  readonly tools: readonly Tool[]
  readonly scripts: StreamEvent[][]
  readonly onConfirm: NonNullable<AgentConfig["onConfirm"]>
}) => {
  const abort = new AbortController()
  const permission = liveProxy()
  const base = {
    llm: new ScriptedLLM(args.scripts),
    registry: new ToolRegistry([...args.tools]),
    stream: new StdoutStream(),
    permission,
    messages: [],
    system: "system",
    cwd: "/tmp/quanta-perm-adv",
    maxTurns: 8,
    signal: abort.signal,
    onConfirm: args.onConfirm,
    // Mirror the web daemon's security config (runtime-factory.ts): the HITL
    // gate enforces hand-off-required ⇒ deny / always-confirm ⇒ ask EVEN under
    // bypass. A source guard (web-daemon-hitl-enabled) pins that the real
    // factory sets this, so this mirror can't drift to a false-green.
    hitl: { enabled: true },
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
  dispose = async () => {
    await session.close()
    await runtime.close()
  }
  const turn = async (text: string) => {
    await session.input.append(text)
    await session.turn.run()
  }
  return { session, permission, turn }
}

describe("permission-mode switch — adversarial e2e", () => {
  // ── THE crown jewel: bypass MUST NOT escalate past HARD security boundaries ──
  test("bypass does NOT auto-run a hand-off-required tool (hard boundary held even with onConfirm approving)", async () => {
    const counts = { n: 0 }
    let asked = 0
    const { session, turn } = await harness({
      tools: [tool("destroyer", counts, "hand-off-required")],
      scripts: turnCalling("destroyer", "x1"),
      onConfirm: async () => {
        asked += 1
        return true // even an APPROVING operator must not unlock a hand-off tool
      },
    })
    await session.permission.set("bypass")
    await turn("destroy it")
    expect(counts.n).toBe(0) // NEVER ran — bypass cannot override hand-off-required
    expect(asked).toBe(0) // hard-deny short-circuits the ask entirely
  })

  test("bypass does NOT skip an always-confirm tool — the touchpoint survives bypass", async () => {
    const counts = { n: 0 }
    let asked = 0
    const { session, turn } = await harness({
      tools: [tool("sensitive", counts, "always-confirm")],
      scripts: turnCalling("sensitive", "x1"),
      onConfirm: async () => {
        asked += 1
        return false // decline at the (still-present) touchpoint
      },
    })
    await session.permission.set("bypass")
    await turn("do the sensitive thing")
    expect(asked).toBe(1) // STILL asked under bypass — always-confirm is not relaxed
    expect(counts.n).toBe(0) // declined ⇒ did not run
  })

  // ── Reversibility: not a one-way latch ──
  test("round-trip default → bypass → default is honored each direction (no latch)", async () => {
    const counts = { n: 0 }
    const { session, turn } = await harness({
      tools: [tool("danger", counts)],
      scripts: [...turnCalling("danger", "a"), ...turnCalling("danger", "b"), ...turnCalling("danger", "c")],
      onConfirm: async () => false, // default/declined ⇒ gated out
    })
    await turn("t1") // default ⇒ asked+declined ⇒ not run
    expect(counts.n).toBe(0)
    await session.permission.set("bypass")
    await turn("t2") // bypass ⇒ auto-run
    expect(counts.n).toBe(1)
    await session.permission.set("default")
    await turn("t3") // back to default ⇒ gated out again
    expect(counts.n).toBe(1)
  })

  // ── Persistence: a single switch sticks across turns ──
  test("a single bypass switch persists across multiple turns", async () => {
    const counts = { n: 0 }
    const { session, turn } = await harness({
      tools: [tool("danger", counts)],
      scripts: [...turnCalling("danger", "a"), ...turnCalling("danger", "b"), ...turnCalling("danger", "c")],
      onConfirm: async () => false,
    })
    await session.permission.set("bypass")
    await turn("t1")
    await turn("t2")
    await turn("t3")
    expect(counts.n).toBe(3) // all three auto-ran under the one switch
  })

  // ── Read-only is always allowed regardless of mode (no spurious ask) ──
  test("a read-only tool auto-runs under default WITHOUT asking (mode-independent)", async () => {
    const counts = { n: 0 }
    let asked = 0
    const { turn } = await harness({
      tools: [readOnlyTool("peek", counts)],
      scripts: turnCalling("peek", "r1"),
      onConfirm: async () => {
        asked += 1
        return true
      },
    })
    await turn("peek under default")
    expect(counts.n).toBe(1) // ran
    expect(asked).toBe(0) // never asked — read-only is allow in every mode
  })

  // ── Fail-closed hardening: malformed modes are IGNORED (never poison the gate) ──
  test("malformed modes (case / whitespace / empty / garbage) are ignored — proxy stays valid", async () => {
    const counts = { n: 0 }
    const { session, permission } = await harness({
      tools: [tool("danger", counts)],
      scripts: [],
      onConfirm: async () => false,
    })
    await session.permission.set("bypass")
    expect(permission.mode).toBe("bypass")
    for (const bad of ["BYPASS", "bypass ", "", "yolo", "Default", "allow"]) {
      await session.permission.set(bad)
      expect(permission.mode).toBe("bypass") // unchanged — fail closed
    }
    // …and a subsequent VALID switch still works (no wedged state).
    await session.permission.set("default")
    expect(permission.mode).toBe("default")
  })
})
