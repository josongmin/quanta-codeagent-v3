/**
 * Hellgate — every PRODUCTION LLMPort decorator preserves the port's capability
 * surface (aug-27).
 *
 * THE DEFECT THIS GUARDS (it actually happened, mid-campaign): `listModels` — the
 * provider model-catalog probe behind `/model` — was added to `LLMPort` and every
 * decorator silently ate it, because each one re-spelled the identity copy inline
 * ("model, provider, surfaceId, transportId, authMode" and sometimes
 * `contextWindowKey`). The CLI's spinner-stall wrapper is the outermost one on the
 * interactive stack, so the surface saw a probe-less port and `/model` could only
 * ever list the boot model. Three decorators had ALSO been dropping
 * `contextWindowKey`, i.e. resolving a granted 1M window as 200k for compaction.
 *
 * So this suite is not about `listModels` specifically: it pins the INVARIANT that
 * a decorator forwards the WHOLE non-stream surface. A new field added to
 * `LLMPort` and forwarded by `forwardPortIdentity` is covered automatically; a
 * decorator that stops using the helper and hand-rolls the copy again goes RED
 * here instead of silently disabling a feature two surfaces away.
 *
 * RED-on-injection: drop any field from `forwardPortIdentity`, or replace one
 * decorator's `...forwardPortIdentity(inner)` with an inline subset ⇒ red.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { RetryingLLM } from "@/agent/retry"
import { buildSpinnerStallLiveWire } from "@/apps/cli/repl/spinner-stall-live-wire"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { withEmptyStreamCircuitBreaker } from "@/llm/empty-stream-breaker"
import { FallbackLLM } from "@/llm/fallback"
import { withImageSanitizationRetry } from "@/llm/image-sanitization-retry/wrapping"
import { withLiveUsage } from "@/llm/live-usage"
import { forwardPortIdentity } from "@/llm/port-identity"
import { recordingLlmPort } from "@/llm/replay/recording-llm"
import { responsesContinuationLlmPort } from "@/llm/responses-continuation-wrapping"
import { withFailureCounter } from "@/llm/retry/too-many-failed-attempts"
import { withStreamProgressTrace } from "@/llm/stream-progress-trace"
import { laneLabeledPort } from "@/llm/with-recording-lane"
import { withTemperature } from "@/llm/with-temperature"
import { laneProgressPort } from "@/runner/batch/eval/lane-progress"

/** A port that exposes EVERY optional field, so a dropped one is observable. */
const fullPort = (): LLMPort & { listModelsCalls: number } => {
  const self = {
    model: "inner-model",
    contextWindowKey: "inner-model-1m",
    provider: "anthropic",
    surfaceId: "anthropic-messages" as const,
    transportId: "public" as const,
    authMode: "Anthropic BYOK",
    listModelsCalls: 0,
    // A `this`-reading METHOD on purpose: the real adapters implement it that
    // way, so a decorator that copies the function value (instead of re-binding
    // the receiver) breaks at call time, not at wrap time.
    async listModels(): Promise<readonly string[]> {
      self.listModelsCalls += 1
      return ["inner-model", "other-model"]
    },
    async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
      yield { type: "message_stop", stop_reason: "end_turn" }
    },
  }
  return self
}

/** Every decorator that sits on a PRODUCTION stack, as `(inner) => port`.
 *  The CLI spinner-stall wrapper is INCLUDED (aug-28): it is the one whose inline
 *  copy actually ate `listModels`, and excluding it left the campaign's own root
 *  cause untested. The census test below then proves this list is COMPLETE. */
/** A no-op continuation store / recording store — these decorators only need the
 *  slot to exist; this suite asserts identity forwarding, not their stream work. */
const STORE = { load: async () => null, save: async () => undefined } as never
const RECORD_STORE = { append: async () => undefined, read: async () => null } as never

const DECORATORS: ReadonlyArray<readonly [string, (inner: LLMPort) => LLMPort]> = [
  ["withTemperature", (inner) => withTemperature(inner, 0.3)],
  ["laneLabeledPort", (inner) => laneLabeledPort(inner, "lane-a")],
  ["withStreamProgressTrace", (inner) => withStreamProgressTrace(inner, {})],
  ["withEmptyStreamCircuitBreaker", (inner) => withEmptyStreamCircuitBreaker(inner, {})],
  [
    "withFailureCounter",
    (inner) => withFailureCounter(inner, { enabled: true, maxConsecutiveFailures: 3 }).port,
  ],
  ["withLiveUsage", (inner) => withLiveUsage(inner, { enabled: true })],
  [
    "withImageSanitizationRetry",
    (inner) =>
      withImageSanitizationRetry(inner, {
        // A no-op sanitization port: this suite only exercises the identity copy.
        replaceLastTurnImages: () => ({ replacedCount: 0, wasMutated: false }),
        replaceLastNMessagesImages: () => ({ replacedCount: 0, wasMutated: false }),
      } as never),
  ],
  ["laneProgressPort", (inner) => laneProgressPort(inner, "lane-b")],
  ["RetryingLLM", (inner) => new RetryingLLM({ inner })],
  ["FallbackLLM", (inner) => new FallbackLLM({ providers: [inner] })],
  [
    "responsesContinuationLlmPort",
    (inner) => responsesContinuationLlmPort({ inner, store: STORE }),
  ],
  ["recordingLlmPort", (inner) => recordingLlmPort({ inner, store: RECORD_STORE })],
  [
    "spinnerStall.wrapLlm",
    (inner) => {
      const wire = buildSpinnerStallLiveWire(true)
      if (wire === undefined) throw new Error("spinner-stall wire did not build")
      return wire.wrapLlm(inner)
    },
  ],
]

/**
 * The non-stream fields a decorated port must answer — a compile-checked
 * `Record` over `LLMPort`'s OWN key set (aug-28).
 *
 * Deriving the list from `forwardPortIdentity`'s output (the first version) made
 * the suite blind in the one direction that matters: a NEW optional `LLMPort`
 * field that the forwarder forgot would be missing from the expectation too, so
 * every decorator could drop it and the suite stayed green. `satisfies
 * Record<Exclude<keyof LLMPort, "stream">, true>` makes the compiler demand an
 * entry per field, and the test below asserts the forwarder's output matches this
 * key set exactly.
 */
const IDENTITY_KEYS = {
  model: true,
  contextWindowKey: true,
  provider: true,
  surfaceId: true,
  transportId: true,
  authMode: true,
  listModels: true,
} satisfies Record<Exclude<keyof LLMPort, "stream">, true>

const IDENTITY_FIELDS = Object.keys(IDENTITY_KEYS) as (keyof LLMPort)[]

/** The ONLY files allowed to spell the identity copy inline:
 *   - `port-identity.ts` — the definition itself;
 *   - `replay/replay-llm.ts` — a cassette player with NO inner port; it SYNTHESIZES
 *     identity from its own options, so there is nothing to forward. */
const IDENTITY_COPY_ALLOWLIST: readonly string[] = [
  "src/llm/port-identity.ts",
  "src/llm/replay/replay-llm.ts",
]

describe("LLMPort decorators preserve the whole capability surface", () => {
  test("the forwarder itself carries every optional field (and re-binds listModels)", async () => {
    const inner = fullPort()
    const copy = forwardPortIdentity(inner)
    // The forwarder must carry EXACTLY the port's non-stream key set — no more
    // (it would invent a field) and no less (a decorator could drop it).
    expect(Object.keys(copy).sort()).toEqual([...IDENTITY_FIELDS].sort())
    // The receiver survives: calling through the copy hits the inner method.
    expect(await copy.listModels?.()).toEqual(["inner-model", "other-model"])
    expect(inner.listModelsCalls).toBe(1)
  })

  for (const [name, wrap] of DECORATORS) {
    test(`${name} forwards every identity field, including listModels`, async () => {
      const inner = fullPort()
      const wrapped = wrap(inner)
      for (const field of IDENTITY_FIELDS) {
        expect(wrapped[field], `${name} dropped ${String(field)}`).toBeDefined()
        // Presence is not enough: a decorator that forwards `provider: "unknown"`
        // or a stale window key would have passed the old presence-only check.
        if (field !== "listModels") {
          expect(wrapped[field], `${name} changed ${String(field)}`).toBe(inner[field])
        }
      }
      // `listModels` must be CALLABLE through the wrapper (bound receiver), not
      // merely present — a copied method reference would throw or read undefined.
      expect(await wrapped.listModels?.()).toEqual(["inner-model", "other-model"])
      expect(inner.listModelsCalls).toBe(1)
    })
  }

  test("CENSUS — no production file hand-rolls the identity copy from an inner port", () => {
    // The list above is hand-maintained, which is exactly how the campaign's own
    // root cause (the spinner-stall wrapper) escaped it. This closes the loop from
    // the other side: a SOURCE sweep for the inline pattern, with a documented
    // allowlist. Add a decorator that re-spells the copy and this goes red even if
    // nobody remembers to extend `DECORATORS`.
    const root = resolve(import.meta.dir, "../../..")
    const out = spawnSync(
      "grep",
      ["-rlE", String.raw`(inner|opts\.inner)\.surfaceId !== undefined \? \{ surfaceId`, "src"],
      { cwd: root, encoding: "utf8" },
    )
    const offenders = (out.stdout ?? "")
      .split("\n")
      .filter((f) => f.length > 0 && !f.includes(".test."))
      .filter((f) => !IDENTITY_COPY_ALLOWLIST.includes(f))
    expect(offenders).toEqual([])
  })

  test("paired control — a port WITHOUT listModels stays without it (no fake capability)", () => {
    const bare: LLMPort = {
      model: "bare",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    }
    for (const [name, wrap] of DECORATORS) {
      expect(wrap(bare).listModels, `${name} invented a listModels`).toBeUndefined()
    }
    expect("listModels" in forwardPortIdentity(bare)).toBe(false)
  })
})
