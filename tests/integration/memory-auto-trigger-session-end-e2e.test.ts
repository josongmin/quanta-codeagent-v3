import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
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
      m.content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "")),
    )
    .join(" ")

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
  private loopTurn = 0
  async *stream(i: StreamInput): AsyncIterable<StreamEvent> {
    if (convo(i).includes(DISTILL_MARKER)) {
      this.distillCalls += 1
      yield { type: "text_delta", delta: DISTILL_JSON }
      yield { type: "message_stop", stop_reason: "end_turn" }
      return
    }
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
    const before = await wires.memoryConsolidator.store!.fetchSince(null)
    expect(before.length).toBe(0)

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools]),
          sessionId: "auto-trigger-e2e-1",
          messages: [{ role: "user", content: [{ type: "text", text: "look at three files then summarize" }] }],
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
    const rows = await wires.memoryConsolidator.store!.fetchSince(null)
    expect(rows.length).toBe(1)
    const row = rows[0]
    if (!row) throw new Error("expected one distilled stage1 row")
    expect(row.threadId).toBe("auto-trigger-e2e-1")
    // The distilled fact survived through the real Phase1Port into the row.
    expect(row.rawMemory).toContain("AUTO-TRIGGER-42")

    wires.dispose()
  })

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
          messages: [{ role: "user", content: [{ type: "text", text: "look at three files then summarize" }] }],
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
    const rows = await wires.memoryConsolidator.store!.fetchSince(null)
    expect(rows.length).toBe(0)

    wires.dispose()
  })
})
