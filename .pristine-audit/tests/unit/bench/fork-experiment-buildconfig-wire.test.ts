import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { StreamPort } from "@/stream"
import { buildConfig } from "../../../src/apps/bench/eval/driver"
import { resolveForkExperiments } from "../../../src/apps/bench/eval/fork-experiments"
import type { Instance } from "../../../src/apps/bench/types"

/**
 * HELLGATE — the fork-experiment seam threads END-TO-END through the bench
 * config builder. The unit suite proves the registry resolves names and the
 * loop e2e proves the mutator fires; this closes the MIDDLE link: that a
 * `turnContextMutator` placed on `RunInstanceDeps` actually lands on the
 * AgentConfig `buildConfig` returns. A regression that dropped the threading
 * (e.g. removed the conditional spread in buildConfig) would make every wired
 * experiment silently inert while the unit + loop tests stay green — this is
 * the differential that catches it.
 *
 * Mirrors the budget-meter wiring hellgate (the analogous DEFAULT-OFF deps
 * field) so the two share a proven harness shape.
 */

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const stubStream: StreamPort = { emit() {} }
const swebenchInstance = (): Instance => ({
  id: "fork-wire-1",
  repoPath: "/tmp/x",
  problemStatement: "inspect only",
  testCmd: "true",
  swebench: { instanceId: "x__fork-1", repo: "x/x", baseCommit: "deadbeef" },
})

const build = (deps: Parameters<typeof buildConfig>[1]) =>
  buildConfig(swebenchInstance(), deps, "/tmp/sb-fork", new AbortController().signal, stubStream)

describe("bench fork-experiment buildConfig wiring", () => {
  test("threads deps.turnContextMutator onto the AgentConfig (the exact function, by reference)", () => {
    const marker = (_turn: number, input: unknown) => input as never
    const cfg = build({
      llm: new StubLLM(),
      maxTurns: 1,
      timeoutMs: 5_000,
      turnContextMutator: marker,
    })
    // Same reference ⇒ the loop will call OUR mutator, not a copy/wrapper.
    expect(cfg.turnContextMutator).toBe(marker)
  })

  test("DEFAULT-OFF: absent deps.turnContextMutator ⇒ config has none (byte-identical posture)", () => {
    const cfg = build({ llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 })
    expect(cfg.turnContextMutator).toBeUndefined()
  })

  test("END-TO-END resolution: a resolved registry experiment's mutator threads through buildConfig", () => {
    // The production wiring is: resolveForkExperiments(env) → deps.turnContextMutator
    // → buildConfig. Drive that exact chain with the `inject` experiment so the
    // test proves the registry output is config-compatible, not a hand-made stub.
    const [exp] = resolveForkExperiments({
      QUANTA_FORK_EXPERIMENT: "inject",
      QUANTA_FORK_INJECT_TURN: "3",
      QUANTA_FORK_INJECT_TEXT: "consider the cache invalidation path",
    })
    expect(exp?.name).toBe("inject")
    const cfg = build({
      llm: new StubLLM(),
      maxTurns: 1,
      timeoutMs: 5_000,
      turnContextMutator: exp?.mutator,
    })
    expect(cfg.turnContextMutator).toBe(exp?.mutator)
  })
})
