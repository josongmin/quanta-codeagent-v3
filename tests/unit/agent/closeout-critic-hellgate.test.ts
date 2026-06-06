/**
 * Closeout-critic HELLGATE (P12 — jun-7 gap-other-agent).
 *
 * HOT-PATH slice. The #1 invariant is: knob OFF or port absent ⇒ the loop's
 * completion seal is BYTE-IDENTICAL to the pre-critic loop (no emit, no
 * allocation, no control-flow change, short-circuit BEFORE any await), and no
 * new throw can reach the loop.
 *
 * Adversarial cases:
 *   (a) knob OFF ⇒ closeout byte-identical (no reviewer invocation, identical
 *       control flow, turn completes; the synchronous OFF gate means NO promise
 *       is even created — the loop never awaits the critic path).
 *   (b) port absent + knob ON ⇒ fail-open, closeout completes, no throw, no
 *       advisory event.
 *   (c) a "denied" verdict surfaces as structured data WITHOUT crashing — the
 *       turn still completes; a THROWING / hanging-but-aborted / poison critic
 *       likewise never blocks or crashes the loop.
 *
 * Plus a source-scan fence so the seam structure cannot regress (OFF gate
 * BEFORE the await; reviewer reached ONLY via the injected port; the helper
 * is no-throw; the gate is applied at BOTH completed seal sites).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type CloseoutCritic, runCloseoutCritic } from "@/agent/closeout-critic"
import { applyAction } from "@/agent/loop/recovery-executor"
import type { AssembledMessage, RecoveryAction } from "@/agent/recovery"
import { createToolChoiceTurnState } from "@/agent/tool-choice"
import type { TurnSession, TurnState } from "@/agent/turn-context"
import type { AgentConfig } from "@/agent/types"
import type { StreamEvent } from "@/llm"
import { createWorkingMemory } from "@/memory"

const ROOT = join(import.meta.dir, "../../..")
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8")

const textMessage = (text: string): AssembledMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

const completedAction: RecoveryAction = { do: "completed" }
// A "proceed" action whose message has NO tool_use ⇒ the SECOND completed seal
// site in applyAction (the no-tool-call path).
const proceedAction: RecoveryAction = { do: "proceed" }

const recoveryEvents = (events: StreamEvent[]): Extract<StreamEvent, { type: "recovery" }>[] =>
  events.filter((e): e is Extract<StreamEvent, { type: "recovery" }> => e.type === "recovery")

const drive = async (
  action: RecoveryAction,
  closeoutCritic: unknown,
): Promise<{ events: StreamEvent[]; result: Awaited<ReturnType<typeof applyAction>> }> => {
  const events: StreamEvent[] = []
  const config = {
    stream: { emit: (e: StreamEvent) => events.push(e) },
    signal: new AbortController().signal,
    ...(closeoutCritic !== undefined ? { closeoutCritic } : {}),
  } as unknown as AgentConfig
  const message = textMessage("done")
  const session = { config, guards: [] } as unknown as TurnSession
  const state = {
    wm: createWorkingMemory(),
    toolChoiceState: createToolChoiceTurnState(),
  } as unknown as TurnState
  const result = await applyAction(
    session,
    state,
    action,
    { message, stopReason: "end_turn", resultBlocks: message.content },
    { blocks: [] } as never,
    [],
  )
  return { events, result }
}

describe("closeout-critic hellgate — (a) knob OFF byte-identical", () => {
  test("undefined config ⇒ completes, zero recovery events (both seal sites)", async () => {
    for (const action of [completedAction, proceedAction]) {
      const { events, result } = await drive(action, undefined)
      expect(result.result.kind).toBe("completed")
      expect(recoveryEvents(events)).toEqual([])
    }
  })

  test("knob OFF performs NO await of the critic path (synchronous short-circuit)", () => {
    // The OFF gate returns `undefined` synchronously so the caller skips the
    // await entirely. We pin the structural guarantee: the gate function
    // returns `Promise<void> | undefined`, returns `undefined` on the OFF
    // branch, and the call sites only await when the return is defined.
    const src = read("src/agent/loop/recovery-executor.ts")
    expect(src).toMatch(/maybeRunCloseoutCritic[\s\S]*?:\s*Promise<void>\s*\|\s*undefined/)
    // OFF gate returns BEFORE building the request / awaiting.
    expect(src).toMatch(/enabled !== true \|\| cfg\.critic === undefined\) return undefined/)
    // Both seal sites guard the await behind a definedness check.
    const guardedAwaits = src.match(/if \(criticDone !== undefined\) await criticDone/g) ?? []
    expect(guardedAwaits.length).toBe(2)
  })

  test("a critic present but enabled:false is NEVER invoked", async () => {
    let called = false
    const critic: CloseoutCritic = async () => {
      called = true
      return { outcome: "approved", rationale: "x" }
    }
    const { events } = await drive(completedAction, { enabled: false, critic })
    expect(called).toBe(false)
    expect(recoveryEvents(events)).toEqual([])
  })
})

describe("closeout-critic hellgate — (b) port absent + ON ⇒ fail-open", () => {
  test("enabled:true, no critic ⇒ completes, no throw, no event", async () => {
    for (const action of [completedAction, proceedAction]) {
      const { events, result } = await drive(action, { enabled: true })
      expect(result.result.kind).toBe("completed")
      expect(recoveryEvents(events)).toEqual([])
    }
  })
})

describe("closeout-critic hellgate — (c) verdicts never block / crash", () => {
  test("DENIED verdict ⇒ advisory event, turn STILL completes", async () => {
    const critic: CloseoutCritic = async () => ({
      outcome: "denied",
      rationale: "unverified claims",
      riskLevel: "high",
    })
    const { events, result } = await drive(completedAction, { enabled: true, critic })
    expect(result.result.kind).toBe("completed")
    expect(recoveryEvents(events)[0]?.reason).toBe("closeout")
    expect(recoveryEvents(events)[0]?.detail).toContain("denied")
  })

  test("THROWING critic ⇒ fail-open, completes, error as data (no loop crash)", async () => {
    const critic: CloseoutCritic = async () => {
      throw new Error("reviewer down")
    }
    const { events, result } = await drive(completedAction, { enabled: true, critic })
    expect(result.result.kind).toBe("completed")
    expect(recoveryEvents(events)[0]?.detail).toBe("critic:unavailable: reviewer down")
  })

  test("SYNCHRONOUSLY-throwing critic (returns no promise) ⇒ still fail-open at helper", async () => {
    // A pathological adapter that throws before returning a promise. The helper
    // wraps the call in try/catch so even a sync throw is caught.
    const poison = (() => {
      throw new Error("sync poison")
    }) as unknown as CloseoutCritic
    const out = await runCloseoutCritic({ enabled: true, critic: poison }, { finalText: "x" })
    expect(out?.detail).toBe("critic:unavailable: sync poison")
  })

  test("critic returning a malformed object ⇒ rendered verbatim, never throws", async () => {
    // The helper does not validate the verdict shape — it renders whatever the
    // adapter returns. A missing rationale stringifies as `undefined`; this must
    // not crash. (Adapters are responsible for shape; the loop must survive.)
    const weird = (async () => ({ outcome: "approved" })) as unknown as CloseoutCritic
    const out = await runCloseoutCritic({ enabled: true, critic: weird }, { finalText: "x" })
    expect(out?.detail).toContain("approved")
  })
})

describe("closeout-critic hellgate — source fence", () => {
  test("reviewer reached ONLY via the injected port (no hardcoded reviewer import)", () => {
    const src = read("src/agent/closeout-critic.ts")
    // The critic module must NOT IMPORT a concrete reviewer/subagent or any
    // loop module — the port is the only channel. (Prose mentions are fine;
    // we forbid actual `import ... from` lines / wiring.) Scan import lines only.
    const importLines = src
      .split(/\r?\n/)
      .filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+["']/.test(l))
    for (const l of importLines) {
      expect(l).not.toContain("reviewer-subagent")
      expect(l).not.toContain("subagent-runner")
      expect(l).not.toMatch(/["']\.\/loop/)
    }
    // Leaf module: ZERO imports (no cycle, no hardcoded reviewer).
    expect(importLines).toEqual([])
    expect(src).not.toContain("createSubagentRunner")
  })

  test("helper never throws — every critic call is try/caught + converted to data", () => {
    const src = read("src/agent/closeout-critic.ts")
    expect(src).toContain("try {")
    expect(src).toContain("catch")
    expect(src).toContain("critic:unavailable")
  })

  test("knob is default-OFF (QUANTA_CLOSEOUT_CRITIC, falsy ⇒ undefined)", () => {
    const src = read("src/runner/knobs/knobs/closeout-critic.ts")
    expect(src).toContain('envKey: "QUANTA_CLOSEOUT_CRITIC"')
    expect(src).toContain("registerKnob(closeoutCriticKnob)")
    // Falsy/garbage ⇒ undefined (no default ON).
    expect(src).toMatch(/return TRUTHY\.has\(raw\) \? \{ enabled: true \} : undefined/)
  })

  test("seam emits via the EXISTING recovery/closeout event (no new event type)", () => {
    const src = read("src/agent/loop/recovery-executor.ts")
    expect(src).toContain('emitRecovery(config, "closeout", observation.detail)')
  })
})
