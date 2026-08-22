/**
 * A2 Hellgate — the artifact PRODUCER WIRING inside `runRuntimeTurn`.
 *
 * The channel hellgate proves the PURE drain (`drainNewArtifacts`) + the mapper.
 * It does NOT prove the load-bearing WIRING: that the turn runner actually drains
 * `base.artifactRegistry` into `result.artifacts`, threads ONE `emittedArtifactIds`
 * ledger across turns, forwards the field via `toSessionHostTurnResult` (the seam
 * the kernel scheduler reads), AND — critically — WITHHOLDS the drain on an ERRORED
 * turn so the artifacts are NOT marked seen-and-lost (they stay pending for the
 * next completed turn; the scheduler only emits `artifact.ready` from its
 * completed-turn arm).
 *
 * These went completely untested at land: mutating the error-guard OUT (drain
 * unconditionally) left every A2 test green. This drives the EXACT exported
 * production entrypoint `runRuntimeTurn` end-to-end with a scripted LLM.
 */

import { describe, expect, test } from "bun:test"
import { type ArtifactRegistry, createArtifactRegistry, monotonicIdFactory } from "@/artifact"
import {
  runRuntimeTurn,
  toSessionHostTurnResult,
} from "@/host/runtime/internal/context-binding/turn-runner"
import type { RuntimeBase } from "@/host/runtime/internal/context-binding/types"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"

type Step = { readonly kind: "events"; readonly events: StreamEvent[] } | { readonly kind: "throw" }

class ScriptedLLM implements LLMPort {
  calls = 0
  readonly model = "scripted-test-model"
  private cursor = 0
  private readonly steps: Step[]
  constructor(steps: Step[]) {
    this.steps = [...steps]
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    // Advance through the script, then STICK on the last step (a completed turn
    // never falls off the end into a spurious "exhausted" error).
    const step = this.steps[Math.min(this.cursor, this.steps.length - 1)]
    this.cursor += 1
    if (step === undefined) throw new LLMError("script exhausted")
    if (step.kind === "throw") throw new LLMError("400 boom — forced error turn")
    for (const e of step.events) yield e
  }
}

class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {}
}

const completing = (): Step => ({
  kind: "events",
  events: [
    { type: "text_delta", delta: "done" },
    { type: "message_stop", stop_reason: "end_turn" },
  ],
})
const erroring = (): Step => ({ kind: "throw" })

/** A minimal RuntimeBase runnable by `runRuntimeTurn` (drives `runAgent`). */
const makeBase = (over: Partial<RuntimeBase> = {}): RuntimeBase =>
  ({
    llm: new ScriptedLLM([completing()]),
    registry: new ToolRegistry([]),
    stream: new NullStream(),
    permission: { mode: "acceptEdits" },
    system: "test-system",
    cwd: "/tmp",
    maxTurns: 3,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    ...over,
  }) as unknown as RuntimeBase

const runTurn = (args: {
  readonly base: RuntimeBase
  readonly emittedArtifactIds?: Set<string>
  readonly history?: readonly Message[]
}) =>
  runRuntimeTurn({
    base: args.base,
    history: args.history ?? [],
    prompt: "go",
    state: undefined,
    idMeta: undefined,
    ...(args.emittedArtifactIds !== undefined
      ? { emittedArtifactIds: args.emittedArtifactIds }
      : {}),
  })

/** Register `count` artifacts (the registry mints monotonic `art-N` ids). */
const seed = (registry: ArtifactRegistry, count: number): void => {
  for (let i = 0; i < count; i += 1) {
    registry.register({ kind: "image", path: `/jail/seed-${i}.png`, mediaType: "image/png" })
  }
}

const reg = (): ArtifactRegistry =>
  createArtifactRegistry({ now: () => 1_700_000_000_000, idFactory: monotonicIdFactory("art") })

describe("A2 wiring — turn runner drains the registry into result.artifacts", () => {
  test("a completed turn drains registered artifacts into result.artifacts (the PRODUCER)", async () => {
    const registry = reg()
    seed(registry, 2)
    const base = makeBase({ artifactRegistry: registry })
    const ledger = new Set<string>()

    const result = await runTurn({ base, emittedArtifactIds: ledger })

    expect(result.outcome.reason).not.toBe("error")
    // RED if the drain block is removed or the registry is not read.
    expect(result.artifacts?.map((r) => r.artifactId)).toEqual(["art-1", "art-2"])
    expect(result.artifacts?.map((r) => r.locator)).toEqual([
      "quanta-artifact://art-1",
      "quanta-artifact://art-2",
    ])
    // The forwarding seam the kernel reads carries the field verbatim.
    const forwarded = toSessionHostTurnResult(result)
    expect(forwarded.artifacts?.map((r) => r.artifactId)).toEqual(["art-1", "art-2"])
  })

  test("store OFF (no base.artifactRegistry) ⇒ artifacts field OMITTED (byte-identical default-OFF)", async () => {
    const registry = reg()
    seed(registry, 1) // artifacts exist, but the store is NOT lifted onto the base
    const result = await runTurn({ base: makeBase() /* no artifactRegistry */ })
    expect("artifacts" in result).toBe(false)
    expect(toSessionHostTurnResult(result).artifacts).toBeUndefined()
  })

  test("ONE ledger across turns ⇒ each artifact drained exactly ONCE (no re-emit)", async () => {
    const registry = reg()
    const base = makeBase({
      artifactRegistry: registry,
      llm: new ScriptedLLM([completing(), completing()]),
    })
    const ledger = new Set<string>()

    seed(registry, 1)
    const turn1 = await runTurn({ base, emittedArtifactIds: ledger })
    expect(turn1.artifacts?.map((r) => r.artifactId)).toEqual(["art-1"])

    // Second turn, SAME ledger, no new registration ⇒ nothing re-emitted.
    const turn2NoNew = await runTurn({ base, emittedArtifactIds: ledger })
    expect("artifacts" in turn2NoNew).toBe(false)

    // A newly-registered artifact IS surfaced on the next turn.
    seed(registry, 1)
    const turn3 = await runTurn({ base, emittedArtifactIds: ledger })
    expect(turn3.artifacts?.map((r) => r.artifactId)).toEqual(["art-2"])
  })
})

describe("A2 wiring — errored-turn artifacts stay PENDING (not seen-and-lost)", () => {
  test("draining is WITHHELD on an errored outcome; a later completed turn surfaces them", async () => {
    const registry = reg()
    seed(registry, 2)
    const base = makeBase({
      artifactRegistry: registry,
      // Turn 1 ERRORS; turn 2 completes.
      llm: new ScriptedLLM([erroring(), completing()]),
    })
    const ledger = new Set<string>()

    const errored = await runTurn({ base, emittedArtifactIds: ledger })
    expect(errored.outcome.reason).toBe("error")
    // The producer must NOT surface artifacts on an errored turn — the scheduler's
    // error arm ignores `result.artifacts`, so surfacing them = seen-and-lost.
    expect("artifacts" in errored).toBe(false)
    // And the ledger must NOT have recorded them as seen (else lost forever).
    expect(ledger.size).toBe(0)

    // The SAME artifacts surface on the next COMPLETED turn — nothing was lost.
    const completed = await runTurn({ base, emittedArtifactIds: ledger })
    expect(completed.outcome.reason).not.toBe("error")
    expect(completed.artifacts?.map((r) => r.artifactId)).toEqual(["art-1", "art-2"])
  })
})
