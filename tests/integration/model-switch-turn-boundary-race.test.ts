/**
 * ★ HELLGATE (MR-03) — a `set_model` frame must LAND before the turn it precedes.
 *
 * THE MEASURED DEFECT. The control drain runs at the top of every turn
 * (`turn-iteration.ts` → `pollControlRequests`), and the web daemon's `set_model`
 * applier was fire-and-forget: it started a durable write and returned. The same
 * turn then read the selection (`stream-consume.ts` → `readStickyModelForMode`)
 * and, the write not having landed, ran the OLD model. Worse, the END-of-turn echo
 * (`scheduler-turn-terminals.ts` → `reconcileTurnModelEcho`) read a by-then-updated
 * cell and reported the NEW one — so `turn.completed.modelSlug`, the `/cost` fold
 * and the work-metrics tag all named a model that never ran, and the browser's
 * read-back poll said "applied".
 *
 * Measured through the REAL `runAgent` before MR-03:
 *     set_model(gpt-4o) queued BEFORE the turn → boot ran 1x, picked ran 0x
 *     store after the turn: undefined            (the write outlived the turn)
 *
 * WHY THE EXISTING WEB TESTS COULD NOT CATCH IT. They poll for the write
 * (`untilSticky`) before asserting, which is precisely the wait the production
 * loop was not doing. A test that waits cannot observe a missing wait.
 *
 * So this BLOCKS the durable write on a gate and drives the real loop:
 *   1. enqueue `set_model(picked)`;
 *   2. hold the store write open;
 *   3. start the turn — and assert NEITHER port has streamed while it is held
 *      (i.e. the loop is genuinely waiting, not racing ahead on the old model);
 *   4. release; only the PICKED port streams, exactly once.
 *
 * RED-on-injection: make `pollControlRequests` non-awaited (or `applyModel`
 * fire-and-forget) ⇒ step 3 sees the boot port already streaming.
 */

import { describe, expect, test } from "bun:test"
import { type AgentConfig, runAgent } from "@/agent"
import type { ControlRequest } from "@/agent/control-request"
import { inMemoryStickyModelStore, type StickyModelStore } from "@/agent/sticky-model"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"

class CountingLLM implements LLMPort {
  calls = 0
  readonly provider = "openai"
  constructor(readonly model: string) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    yield { type: "text_delta", delta: "ok" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** A store whose WRITE is held open until the test releases it — the production
 *  shape (`write-file-atomic` does mkdir + tmp write + rename) made deterministic.
 *  Reads are honest throughout: they return the pre-write value until release. */
const gatedStore = (): {
  readonly store: StickyModelStore
  readonly release: () => void
  readonly writeStarted: () => boolean
} => {
  const inner = inMemoryStickyModelStore()
  let started = false
  let open!: () => void
  const gate = new Promise<void>((r) => {
    open = r
  })
  return {
    writeStarted: () => started,
    release: open,
    store: {
      get: inner.get.bind(inner),
      peek: inner.peek.bind(inner),
      load: inner.load.bind(inner),
      unset: inner.unset.bind(inner),
      set: async (input) => {
        started = true
        await gate
        return await inner.set(input)
      },
    },
  }
}

const oneFrame = (request: ControlRequest) => {
  let handed = false
  return {
    next: (): ControlRequest | null => {
      if (handed) return null
      handed = true
      return request
    },
  }
}

describe("MR-03 — the turn waits for a set_model write", () => {
  test("the picked model runs on THAT turn; nothing streams while the write is held", async () => {
    const boot = new CountingLLM("boot-model")
    const picked = new CountingLLM("gpt-4o")
    const gate = gatedStore()

    const cfg = {
      llm: boot,
      cwd: "/tmp",
      registry: new ToolRegistry(defaultTools),
      stream: { emit: () => undefined },
      permission: { mode: "acceptEdits" },
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      system: "t",
      maxTurns: 2,
      signal: new AbortController().signal,
      stickyModelStore: {
        store: gate.store,
        provider: "openai",
        effectiveModel: () => gate.store.peek({ mode: "default", provider: "openai" }),
      },
      modelCandidates: [{ id: "gpt-4o", port: picked }],
      controlRequest: {
        port: oneFrame({ kind: "set_model", model: "gpt-4o" }),
        context: { modelAllowlist: ["boot-model", "gpt-4o"] },
        applier: {
          setModel: async (model: string) => {
            const res = await gate.store.set({
              mode: "default",
              provider: "openai",
              modelId: model,
            })
            return res.ok
              ? ({ ok: true } as const)
              : ({ ok: false, reason: "write failed" } as const)
          },
        },
        env: { QUANTA_CONTROL_REQUEST: "1" },
      },
    } as unknown as AgentConfig

    const running = runAgent(cfg)

    // Let the loop reach the drain and block on the held write. Generous enough
    // that a NON-waiting loop would certainly have started streaming by now — the
    // pre-MR-03 measurement had the boot port finish an entire turn in this window.
    await new Promise((r) => setTimeout(r, 60))
    expect(gate.writeStarted()).toBe(true)
    expect([boot.calls, picked.calls]).toEqual([0, 0])

    gate.release()
    await running

    // Exactly the picked model, exactly once — and the boot port never ran.
    expect([boot.calls, picked.calls]).toEqual([0, 1])
    expect(gate.store.peek({ mode: "default", provider: "openai" })).toBe("gpt-4o")
  }, 20_000)

  test("paired control — NO frame ⇒ the boot model runs, unchanged", async () => {
    const boot = new CountingLLM("boot-model")
    const picked = new CountingLLM("gpt-4o")
    const store = inMemoryStickyModelStore()
    const cfg = {
      llm: boot,
      cwd: "/tmp",
      registry: new ToolRegistry(defaultTools),
      stream: { emit: () => undefined },
      permission: { mode: "acceptEdits" },
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      system: "t",
      maxTurns: 2,
      signal: new AbortController().signal,
      stickyModelStore: { store, provider: "openai" },
      modelCandidates: [{ id: "gpt-4o", port: picked }],
      controlRequest: {
        port: { next: (): ControlRequest | null => null },
        context: { modelAllowlist: ["boot-model", "gpt-4o"] },
        applier: {},
        env: { QUANTA_CONTROL_REQUEST: "1" },
      },
    } as unknown as AgentConfig
    await runAgent(cfg)
    expect([boot.calls, picked.calls]).toEqual([1, 0])
  }, 20_000)

  test("a REJECTED write is echoed as `rejected`, not as `model-set`", async () => {
    // The client's echo is its only signal. Reporting success for a write the
    // store refused is the other half of the same lie.
    const { drainControlRequests } = await import("@/agent/control-request")
    const effects = await drainControlRequests(
      oneFrame({ kind: "set_model", model: "gpt-4o" }),
      { modelAllowlist: ["gpt-4o"] },
      { setModel: async () => ({ ok: false, reason: "disk full" }) },
    )
    expect(effects).toEqual([{ kind: "rejected", reason: "disk full" }])
  })
})
