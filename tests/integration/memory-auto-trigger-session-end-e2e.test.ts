<<<<<<< HEAD
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
=======
>>>>>>> origin/main
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
<<<<<<< HEAD
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput, SystemBlock } from "@/llm"
=======
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
>>>>>>> origin/main
import { buildSessionMemoryAutoWires } from "@/runner/session-memory-auto"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for the ADR-0281 memory auto-trigger session-end
 * consolidation (feature `memory-auto-trigger`).
 *
 * The GAP this closes (see `tests/unit/cli/session-memory-auto.test.ts`): the
 * existing coverage asserts only the CONFIG SLOT the assembler produces —
 * `out.memoryConsolidator.enabled === true`, `out.memoryConsolidator.defer`
 * present — and the lane mechanics. It NEVER threads the produced block through
 * `runAgent` to prove the session-end DECISION actually FIRES the distill and
 * writes a durable row. "Knob is set" ≠ "hook ran".
 *
 * This drives the WHOLE path through the REAL assembler + REAL loop:
 *
 *   assembleMemoryAuto(env) decides auto-trigger is ON (ADR-0413 default)
 *     → buildSessionMemoryAutoWires mints the real `memoryConsolidator` block
 *       (real scripted-LLM-backed Phase1Port + real sqlite Stage1Store + defer)
 *         → runAgent runs a multi-turn session (turns ≥ MIN_TURN_THRESHOLD)
 *           → session-end hook FIRES at the boundary (spanStatus === "ok")
 *             → the distill runs, a REAL sqlite row is written (fresh readback)
 *
 * Non-vacuity: the CONTROL run sets `QUANTA_MEMORY_AUTO=off` ⇒ the assembler
 * returns `undefined` (no block) ⇒ no session-end firing ⇒ ZERO rows. That
 * discriminator proves the assertion below is not passing on the config slot.
 *
 * Offline: the scripted `LLMPort` never touches the network. `homeDir` is a
 * throwaway tmp dir so the sqlite store + memory files are isolated per test.
 */

const convo = (i: StreamInput): string =>
  i.messages
    .flatMap((m) =>
<<<<<<< HEAD
      m.content.map((b) =>
        b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "",
      ),
    )
    .join(" ")

const systemText = (system: StreamInput["system"]): string => {
  if (system === undefined) return ""
  if (typeof system === "string") return system
  return (system as SystemBlock[]).map((block) => block.text).join("\n")
}

=======
      m.content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "")),
    )
    .join(" ")

>>>>>>> origin/main
// The distill prompt begins with this marker (see src/agent/memory-distill.ts).
const DISTILL_MARKER = "You distill durable long-term memory"

// The durable statement the distill returns — must survive into the sqlite row.
const DISTILLED_FACT = "the team pins bun and runs rg before grep (AUTO-TRIGGER-42)"
const DISTILL_JSON = JSON.stringify([
  { kind: "fact", tier: "semantic", text: DISTILLED_FACT, importance: 0.9 },
])

/**
 * One scripted model that serves BOTH roles:
 *   - The main agent loop: 3 back-to-back `read` tool_use turns then a final
 *     answer, so `outcome.turns >= MIN_TURN_THRESHOLD (3)` and the session ends
 *     `completed` (spanStatus "ok" — the session-end hook's precondition).
 *   - The session-end distill (a SEPARATE `distillSession` LLM call whose
 *     prompt carries {@link DISTILL_MARKER}): returns {@link DISTILL_JSON}.
 */
class DualRoleLLM implements LLMPort {
  readonly model = "auto-trigger-test-model"
  distillCalls = 0
<<<<<<< HEAD
  readonly seenSystem: string[] = []
=======
>>>>>>> origin/main
  private loopTurn = 0
  async *stream(i: StreamInput): AsyncIterable<StreamEvent> {
    if (convo(i).includes(DISTILL_MARKER)) {
      this.distillCalls += 1
      yield { type: "text_delta", delta: DISTILL_JSON }
      yield { type: "message_stop", stop_reason: "end_turn" }
      return
    }
<<<<<<< HEAD
    this.seenSystem.push(systemText(i.system))
=======
>>>>>>> origin/main
    const n = this.loopTurn++
    if (n < 3) {
      yield { type: "tool_use_start", id: `t${n}`, name: "read" }
      yield { type: "tool_use_end", id: `t${n}`, input: { path: `/tmp/does-not-exist-${n}` } }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

<<<<<<< HEAD
class PromptCapturingLLM implements LLMPort {
  readonly model = "auto-trigger-prompt-capture-model"
  readonly seenSystem: string[] = []
  async *stream(i: StreamInput): AsyncIterable<StreamEvent> {
    this.seenSystem.push(systemText(i.system))
    yield { type: "text_delta", delta: "acknowledged" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

=======
>>>>>>> origin/main
describe("memory auto-trigger — session-end consolidation fires through runAgent", () => {
  let tempHome: string
  beforeEach(() => {
    __resetRuntimeConfig()
    tempHome = mkdtempSync(join(tmpdir(), "q-auto-trigger-e2e-"))
  })
  afterEach(async () => {
    __resetRuntimeConfig()
    await rm(tempHome, { recursive: true, force: true })
  })

  test("auto-trigger ON (default) ⇒ the REAL session-end hook distills + writes a durable sqlite row", async () => {
    const llm = new DualRoleLLM()
    // The ASSEMBLER decides auto-trigger is on and mints the real consolidator
    // block (real Phase1Port over `llm`, real sqlite Stage1Store, defer lane).
    const wires = await buildSessionMemoryAutoWires({
      env: {}, // empty ⇒ ADR-0413 default-ON
      llm,
      sessionId: "auto-trigger-e2e-1",
      homeDir: tempHome,
    })
    if (wires === undefined) throw new Error("expected auto-trigger wires (default-ON)")
    // Pre-condition: the durable store is empty before the session runs.
<<<<<<< HEAD
    const stage1Store = wires.memoryConsolidator.store
    if (stage1Store === undefined) throw new Error("expected auto-trigger stage1 store")
    const before = await stage1Store.fetchSince(null)
=======
    const before = await wires.memoryConsolidator.store!.fetchSince(null)
>>>>>>> origin/main
    expect(before.length).toBe(0)

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools]),
          sessionId: "auto-trigger-e2e-1",
<<<<<<< HEAD
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "look at three files then summarize" }],
            },
          ],
=======
          messages: [{ role: "user", content: [{ type: "text", text: "look at three files then summarize" }] }],
>>>>>>> origin/main
          maxTurns: 10,
          // The block the ASSEMBLER produced — NOT a hand-built literal.
          memoryConsolidator: wires.memoryConsolidator,
        }),
      ),
      15_000,
      "memory-auto-trigger-session-end-e2e",
    )
    // The distill was handed to the defer lane; the host owns the drain BEFORE
    // reading the store the distill writes to (real session-close ordering).
    await wires.drain()

    // Session finished clean (the session-end hook only fires on spanStatus ok)
    // and ran enough real turns to clear MIN_TURN_THRESHOLD.
    expect(out.reason).toBe("completed")
    expect(out.turns).toBeGreaterThanOrEqual(3)

    // LOAD-BEARING: the session-end DECISION actually FIRED — the distill LLM
    // call ran and a REAL sqlite row was written (fresh readback off the store
    // the assembler minted, NOT the config slot).
    expect(llm.distillCalls).toBe(1)
<<<<<<< HEAD
    const rows = await stage1Store.fetchSince(null)
=======
    const rows = await wires.memoryConsolidator.store!.fetchSince(null)
>>>>>>> origin/main
    expect(rows.length).toBe(1)
    const row = rows[0]
    if (!row) throw new Error("expected one distilled stage1 row")
    expect(row.threadId).toBe("auto-trigger-e2e-1")
    // The distilled fact survived through the real Phase1Port into the row.
    expect(row.rawMemory).toContain("AUTO-TRIGGER-42")

    wires.dispose()
  })

<<<<<<< HEAD
  test("session-end persisted stage1 entry reaches the NEXT session's system prompt", async () => {
    const priorLlm = new DualRoleLLM()
    const prior = await buildSessionMemoryAutoWires({
      env: {},
      llm: priorLlm,
      sessionId: "auto-trigger-lifecycle-prior",
      homeDir: tempHome,
    })
    if (prior === undefined) throw new Error("expected default-on memory wires")

    const first = await withTimeout(
      runAgent(
        cfg({
          llm: priorLlm,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools]),
          sessionId: "auto-trigger-lifecycle-prior",
          messages: [{ role: "user", content: [{ type: "text", text: "remember the workflow" }] }],
          maxTurns: 10,
          memoryConsolidator: prior.memoryConsolidator,
          // This is the production host's sibling output-store wire.
          stage1OutputsStore: prior.stage1OutputsStore,
        }),
      ),
      15_000,
      "memory-auto-trigger-lifecycle-prior",
    )
    await prior.drain()
    expect(first.reason).toBe("completed")
    expect(prior.stage1OutputsStore.get("auto-trigger-lifecycle-prior")?.usageCount).toBe(1)
    prior.dispose()

    const nextLlm = new PromptCapturingLLM()
    const next = await buildSessionMemoryAutoWires({
      env: {},
      llm: nextLlm,
      sessionId: "auto-trigger-lifecycle-next",
      homeDir: tempHome,
    })
    if (next === undefined) throw new Error("expected default-on memory wires")
    if (next.sessionCtx === undefined) throw new Error("expected prior session memory injection")

    const second = await withTimeout(
      runAgent(
        cfg({
          llm: nextLlm,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools]),
          sessionId: "auto-trigger-lifecycle-next",
          messages: [{ role: "user", content: [{ type: "text", text: "what carries forward?" }] }],
          maxTurns: 1,
          sessionCtx: next.sessionCtx,
        }),
      ),
      15_000,
      "memory-auto-trigger-lifecycle-next",
    )
    next.dispose()

    expect(second.reason).toBe("completed")
    expect(nextLlm.seenSystem.some((system) => system.includes(DISTILLED_FACT))).toBe(true)
  })

  test("resolved promotion policy can reject a session-end row before next-session injection", async () => {
    const llm = new DualRoleLLM()
    const prior = await buildSessionMemoryAutoWires({
      env: { QUANTA_MEMORY_THRESHOLD: "1.1" },
      llm,
      sessionId: "auto-trigger-policy-off-prior",
      homeDir: tempHome,
    })
    if (prior === undefined) throw new Error("expected default-on memory wires")

    await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools]),
          sessionId: "auto-trigger-policy-off-prior",
          messages: [{ role: "user", content: [{ type: "text", text: "remember the workflow" }] }],
          maxTurns: 10,
          memoryConsolidator: prior.memoryConsolidator,
          stage1OutputsStore: prior.stage1OutputsStore,
        }),
      ),
      15_000,
      "memory-auto-trigger-policy-off-prior",
    )
    await prior.drain()
    expect(prior.stage1OutputsStore.get("auto-trigger-policy-off-prior")?.selectedForPhase2).toBe(
      false,
    )
    prior.dispose()

    const next = await buildSessionMemoryAutoWires({
      env: { QUANTA_MEMORY_THRESHOLD: "1.1" },
      llm: new DualRoleLLM(),
      sessionId: "auto-trigger-policy-off-next",
      homeDir: tempHome,
    })
    if (next === undefined) throw new Error("expected default-on memory wires")
    expect(next.sessionCtx).toBeUndefined()
    next.dispose()
  })

=======
>>>>>>> origin/main
  test("CONTROL: QUANTA_MEMORY_AUTO=off ⇒ assembler returns NO wires ⇒ no session-end firing (non-vacuous)", async () => {
    const llm = new DualRoleLLM()
    // Explicit opt-out ⇒ the assembler returns undefined (no consolidator block
    // is ever produced), so there is nothing to fire at session-end.
    const wires = await buildSessionMemoryAutoWires({
      env: { QUANTA_MEMORY_AUTO: "off" },
      llm,
      sessionId: "auto-trigger-e2e-off-1",
      homeDir: tempHome,
    })
    expect(wires).toBeUndefined()

    // Run the SAME multi-turn session but with NO consolidator wired (mirrors
    // the production path when auto-trigger is off).
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools]),
          sessionId: "auto-trigger-e2e-off-1",
<<<<<<< HEAD
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "look at three files then summarize" }],
            },
          ],
=======
          messages: [{ role: "user", content: [{ type: "text", text: "look at three files then summarize" }] }],
>>>>>>> origin/main
          maxTurns: 10,
        }),
      ),
      15_000,
      "memory-auto-trigger-session-end-e2e-off",
    )
    expect(out.reason).toBe("completed")
    expect(out.turns).toBeGreaterThanOrEqual(3)
    // The DISCRIMINATOR: with auto-trigger off, the session-end distill NEVER
    // runs. If the ON assertion above were vacuous (asserting on the slot, not
    // the firing), this control would still show a distill call — it must NOT.
    expect(llm.distillCalls).toBe(0)
  })

  test("NEUTER: block WIRED but session ENDS IN ERROR ⇒ session-end boundary NOT reached ⇒ no distill, no row", async () => {
    // The consolidator block IS present (same assembler-minted wires), so this
    // proves the ON assertion keys on the actual session-boundary FIRING
    // (spanStatus === "ok"), not merely on the block being configured. An
    // errored session never reaches the hook — mutate the loop to error and the
    // load-bearing `rows.length === 1` goes RED.
    const distillLlm = new DualRoleLLM()
    const wires = await buildSessionMemoryAutoWires({
      env: {},
      llm: distillLlm,
      sessionId: "auto-trigger-e2e-err-1",
      homeDir: tempHome,
    })
    if (wires === undefined) throw new Error("expected auto-trigger wires (default-ON)")

    // A model that yields an unparseable shape so the loop errors out (matches
    // the established "error session does NOT trigger the hook" pattern).
    const errLlm: LLMPort = {
      model: "err-model",
      async *stream(): AsyncIterable<StreamEvent> {
        await Promise.resolve()
        yield { type: "message_stop", stop_reason: "tool_use" }
      },
    }
    await withTimeout(
      runAgent(
        cfg({
          llm: errLlm,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools]),
          sessionId: "auto-trigger-e2e-err-1",
          messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
          maxTurns: 1,
          memoryConsolidator: wires.memoryConsolidator,
        }),
      ),
      15_000,
      "memory-auto-trigger-session-end-e2e-err",
    )
    await wires.drain()

    // Session-end distill never ran (boundary not reached) and no durable row
    // was written despite the block being fully wired.
    expect(distillLlm.distillCalls).toBe(0)
<<<<<<< HEAD
    const stage1Store = wires.memoryConsolidator.store
    if (stage1Store === undefined) throw new Error("expected auto-trigger stage1 store")
    const rows = await stage1Store.fetchSince(null)
=======
    const rows = await wires.memoryConsolidator.store!.fetchSince(null)
>>>>>>> origin/main
    expect(rows.length).toBe(0)

    wires.dispose()
  })
})
