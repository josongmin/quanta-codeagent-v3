import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, runAgent } from "@/agent"
import { createBriefStore } from "@/agent/brief"
import { handleSubmissionControlOp } from "@/agent/loop/session-lifecycle"
import type { Submission } from "@/agent/submission"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/**
 * #17 (C3) — `AgentConfig.sessionBrief` LOOP-WIRING hellgate.
 *
 * The brief PROMPT mechanism (input.brief ⇒ BRIEF_NOTICE in the dynamic tail) is
 * already pinned by `brief-mode-hellgate.test.ts`. THIS file proves the NEW
 * SEAMS I added connect the session store to that mechanism:
 *
 *   A. context-assembler reads `config.sessionBrief()` and threads it into
 *      `buildTurnContext({ brief })`, so the directive ACTUALLY rides the prompt
 *      sent to the provider when the session posture is ON. Without the
 *      `...(config.sessionBrief?.() === true ? { brief: true } : {})` line the
 *      ON case goes RED (the marker never reaches the LLM input).
 *   B. `handleSubmissionControlOp` routes a `set_brief` submission through
 *      `applyBriefTransition`, mutating the SAME store the read accessor reads.
 *      Without the `isSetBriefOp(...)` block the mutation never happens (RED).
 *
 * Strategy: a recording LLM captures the EXACT `StreamInput.messages` the loop
 * sends. The brief directive is a DYNAMIC trailing `<system-reminder>` user
 * message — so we assert on the last user message's text (a real observable
 * effect at the provider boundary, not a tautology over the store).
 */

const MARKER = "BRIEF MODE is active"

class CapturingLLM implements LLMPort {
  readonly model = "capturing"
  lastUserText = ""
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    // The dynamic context rides the FINAL user message (trailing reminder).
    const lastUser = [...input.messages].reverse().find((m) => m.role === "user")
    this.lastUserText = (lastUser?.content ?? [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
    yield { type: "text_delta", delta: "ok" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class NoopStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

const baseCfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new NoopStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [userText("go")],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 3,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

let permRoot: string | null = null
const originalPermState = process.env.QUANTA_PERMISSION_STATE
beforeEach(() => {
  permRoot = mkdtempSync(join(tmpdir(), "brief-wire-"))
  process.env.QUANTA_PERMISSION_STATE = join(permRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})
afterEach(() => {
  if (permRoot !== null) {
    rmSync(permRoot, { recursive: true, force: true })
    permRoot = null
  }
  if (originalPermState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

describe("#17 — config.sessionBrief reaches the provider prompt (A: assembler wiring)", () => {
  test("PAIRED — sessionBrief()=true ⇒ BRIEF_NOTICE in the sent prompt; ()=false ⇒ absent", async () => {
    // ON arm: the session posture is ON, so the loop must splice the directive.
    const onLlm = new CapturingLLM()
    await runAgent(baseCfg({ llm: onLlm, messages: [userText("hi")], sessionBrief: () => true }))
    expect(onLlm.lastUserText).toContain(MARKER)

    // OFF arm (control): same call, posture OFF ⇒ the directive must NOT appear.
    // The delta between the two arms is the causal proof the read is load-bearing.
    const offLlm = new CapturingLLM()
    await runAgent(baseCfg({ llm: offLlm, messages: [userText("hi")], sessionBrief: () => false }))
    expect(offLlm.lastUserText).not.toContain(MARKER)
  })

  test("absent sessionBrief ⇒ no directive (default-OFF byte-identical to false)", async () => {
    const llm = new CapturingLLM()
    await runAgent(baseCfg({ llm, messages: [userText("hi")] }))
    expect(llm.lastUserText).not.toContain(MARKER)
  })
})

describe("#17 — set_brief control-op routes through the loop handler (B: control-op wiring)", () => {
  const setBrief = (on: boolean): Submission => ({ id: "s1", op: { kind: "set_brief", on } })
  const setMode = (): Submission => ({ id: "s2", op: { kind: "set_mode", mode: "plan" } })

  const cfgWith = (submission: Submission, store: ReturnType<typeof createBriefStore>) =>
    ({ submission, briefStore: store, stream: new NoopStream() }) as unknown as AgentConfig

  test("PAIRED — set_brief(true/false) flips the SAME store the loop reads (fresh-readback)", () => {
    const store = createBriefStore(false)
    handleSubmissionControlOp(cfgWith(setBrief(true), store), undefined)
    expect(store.get()).toBe(true) // fresh read through the accessor, not the op value
    handleSubmissionControlOp(cfgWith(setBrief(false), store), undefined)
    expect(store.get()).toBe(false)
  })

  test("CONTROL — a non-brief op (set_mode) never touches the brief store", () => {
    const store = createBriefStore(false)
    handleSubmissionControlOp(cfgWith(setMode(), store), undefined)
    expect(store.get()).toBe(false)
  })

  test("registry-absent — set_brief with no store is observed-and-ignored (no throw)", () => {
    const cfg = { submission: setBrief(true), stream: new NoopStream() } as unknown as AgentConfig
    expect(() => handleSubmissionControlOp(cfg, undefined)).not.toThrow()
  })
})
