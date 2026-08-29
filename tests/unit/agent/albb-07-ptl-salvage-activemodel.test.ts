/**
 * ALBB-07 Claim 2 — reactive `dropOldestSalvage` must target the ACTIVE model
 * window, not the base `config.llm` window.
 *
 * Ground-truth defect: `recovery-executor.ts` computed the salvage
 * `targetTokens` with a BARE `resolveWindowModel(config.llm)` — dropping the
 * already-resolved `activeModel` that `same-turn-engine.ts` threads into
 * `prepareTurnContext`. So a sticky/skill swap onto a SMALLER-window model would
 * shed against the BASE window and under-shed. The PROACTIVE path already threads
 * `activeModel` end-to-end (`compaction-wire.ts` `resolveWindowModel(config.llm,
 * activeModel)`); this is a pure wiring gap.
 *
 * The test drives the REAL `runAgent` loop into a reactive compaction with
 * `dropOldestSalvage` ON, and spies on `dropOldestSalvage`'s `targetTokens`
 * argument via the recovery-executor's `__setDropOldestSalvageForTest` seam (NOT
 * `mock.module`, which leaks process-globally + binds at collection and would
 * pollute sibling files using the real compaction).
 *
 *   - MAIN: sticky swap base `gpt-5` (400k window) → active `gpt-4o` (128k
 *     window). The observed `targetTokens` MUST equal the gpt-4o-derived limit,
 *     NOT the gpt-5-derived limit.
 *   - CONTROL (proves the wire, not a constant): NO sticky swap ⇒ `targetTokens`
 *     equals the base gpt-5-derived limit.
 *
 * Mutation guard: reverting recovery-executor's salvage target from
 * `resolveWindowModel(config.llm, activeModel)` to the bare
 * `resolveWindowModel(config.llm)` (or dropping `activeModel` from the
 * `applyAction` call in `same-turn-engine.ts`) collapses the MAIN target back to
 * the base window ⇒ RED.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import { resolveCompactionLimitTokens } from "@/agent/compaction"
import {
  __resetDropOldestSalvageForTest,
  __setDropOldestSalvageForTest,
} from "@/agent/loop/recovery-executor"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig, LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

// Capture every `targetTokens` the reactive salvage was called with, then return a
// valid reactive-style success so the loop proceeds past compaction and completes
// (mirrors the real `{ok:true}` shape). Injected through the recovery-executor test
// SEAM rather than `mock.module("@/agent/compaction")`: bun's module mock leaks
// PROCESS-GLOBALLY and binds at collection, silently polluting sibling files that
// use the real compaction (drop-oldest-salvage-hellgate). The seam confines the spy
// to this file (the executor reads it at call time; every other importer of the real
// `dropOldestSalvage` is unaffected).
const salvageTargets: (number | undefined)[] = []
beforeEach(() => {
  __setDropOldestSalvageForTest((async (input: { targetTokens?: number; messages: unknown[] }) => {
    salvageTargets.push(input.targetTokens)
    return {
      ok: true as const,
      messages: (input.messages as Message[]).slice(-3),
      summaryTokens: 10,
      droppedRounds: 0,
      strategy: "reactive" as const,
    }
  }) as never)
})
afterEach(() => __resetDropOldestSalvageForTest())

type Step = { kind: "throw"; error: unknown } | { kind: "events"; events: StreamEvent[] }

class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  constructor(
    readonly model: string,
    private readonly steps: Step[],
  ) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const step = this.steps.shift() ?? this.steps[this.steps.length - 1]
    if (!step) throw new LLMError("script exhausted")
    if (step.kind === "throw") throw step.error
    for (const e of step.events) yield e
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const text = (t: string, stop = "end_turn"): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: stop },
]
const ev = (events: StreamEvent[]): Step => ({ kind: "events", events })
const thr = (error: unknown): Step => ({ kind: "throw", error })

const successHistory = (): Message[] => [
  { role: "user", content: [{ type: "text", text: "first request" }] },
  { role: "assistant", content: [{ type: "text", text: "older turn one" }] },
  { role: "user", content: [{ type: "text", text: "second request" }] },
  { role: "assistant", content: [{ type: "text", text: "older turn two" }] },
  { role: "user", content: [{ type: "text", text: "third request" }] },
  { role: "assistant", content: [{ type: "text", text: "older turn three" }] },
  { role: "user", content: [{ type: "text", text: "current request" }] },
]

// One reactive compaction: PTL throw → `compact` → salvage (mocked) → final.
const oneReactiveScript = (): Step[] => [
  thr(new LLMError("400 prompt is too long for this model")),
  ev(text("<summary>resume from here</summary>")),
  ev(text("final answer after compaction")),
]

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 2,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  compaction: { dropOldestSalvage: true },
  ...over,
})

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${label} in ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null

beforeEach(() => {
  salvageTargets.length = 0
  permissionStateRoot = mkdtempSync(join(tmpdir(), "albb07-salvage-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permissionStateRoot !== null) {
    rmSync(permissionStateRoot, { recursive: true, force: true })
    permissionStateRoot = null
  }
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

describe("ALBB-07 claim 2 — reactive salvage targets the ACTIVE model window", () => {
  // Expected limits derived from the REAL resolver so the assertion proves the
  // wire (which model id flows in), not a hardcoded constant.
  const baseLimit = resolveCompactionLimitTokens(undefined, "gpt-5")
  const activeLimit = resolveCompactionLimitTokens(undefined, "gpt-4o")

  test("sanity: base and active windows derive DIFFERENT limits", () => {
    expect(baseLimit).not.toBe(activeLimit)
  })

  test("MAIN — sticky swap to a smaller-window model ⇒ salvage targets the ACTIVE (small) window", async () => {
    const base = new ScriptedLLM("gpt-5", oneReactiveScript())
    // The swapped candidate port drives the SAME script (stateful) but names the
    // smaller-window active model — this is the id `resolveActiveModelId` returns.
    const activePort = new ScriptedLLM("gpt-4o", [])
    activePort.stream = base.stream.bind(base)
    const stickyStore = {
      get: async () => "cand-gpt-4o",
      // `peek` is a REQUIRED port method and the routing view is SYNC, so a double
      // that answers only `get` reads as "no preference" and the swap silently
      // vanishes. The cast below is what let this shape compile.
      peek: () => "cand-gpt-4o",
      set: async () => ({ ok: true as const }),
      unset: async () => ({ ok: true as const }),
      load: async () => ({ ok: true as const, entries: {} }),
    } as unknown as import("@/agent/sticky-model").StickyModelStore

    const out = await withTimeout(
      runAgent(
        cfg({
          llm: base,
          messages: successHistory(),
          modelCandidates: [{ id: "cand-gpt-4o", port: activePort }],
          stickyModelStore: { store: stickyStore },
        }),
      ),
      20_000,
      "albb07-main",
    )
    expect(out.reason).toBe("completed")
    expect(salvageTargets.length).toBe(1)
    expect(salvageTargets[0]).toBe(activeLimit)
    expect(salvageTargets[0]).not.toBe(baseLimit)
  })

  test("CONTROL — no sticky swap ⇒ salvage targets the BASE window (proves the wire, not a constant)", async () => {
    const base = new ScriptedLLM("gpt-5", oneReactiveScript())
    const out = await withTimeout(
      runAgent(cfg({ llm: base, messages: successHistory() })),
      20_000,
      "albb07-control",
    )
    expect(out.reason).toBe("completed")
    expect(salvageTargets.length).toBe(1)
    expect(salvageTargets[0]).toBe(baseLimit)
  })
})
