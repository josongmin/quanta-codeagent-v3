/**
 * Hellgate (RED-first) — bench token/cost SSOT repair (docs/plans/jun-26-bench-token-usage-tracking.md).
 *
 * Two layers are repaired here, both proven against the real modules:
 *
 *  Gap 1 — report serialization: `buildReport` must copy `InstanceResult.usage`
 *          and `InstanceResult.durationMs` onto `perInstance[]` so `report.json`
 *          carries the SSOT that `cost.ts` path-1 reads. Absent fields stay
 *          ABSENT (byte-identical to the pre-feature report shape).
 *
 *  Gap 2 — non-lossy usage: `UsageTap` must accumulate the cache buckets the
 *          stream already emits (`cacheReadTokens` / `cacheCreationTokens`),
 *          summed across multiple `usage` events in one instance, and surface
 *          them on `total()`. Zero buckets are omitted (no fabricated keys).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildWiring } from "@/../src/runner/batch/eval/report"
import { UsageTap } from "@/../src/runner/batch/observe"
import { buildReport } from "@/../src/runner/batch/report"
import type { Instance, InstanceResult } from "@/../src/runner/batch/types"
import type { AgentEvent } from "@/stream"

const baseResult = (over: Partial<InstanceResult>): InstanceResult => ({
  id: "psf__requests-1",
  passed: true,
  patch: "diff --git a/x b/x\n",
  turns: 3,
  ...over,
})

const meta = { model: "gpt-5.4", provider: "chatgpt-oauth", n: 1 }

describe("Gap 1 — buildReport serializes usage + durationMs", () => {
  test("usage and durationMs land on perInstance[] when present", () => {
    const report = buildReport(meta, [
      baseResult({
        durationMs: 42_000,
        usage: {
          model: "gpt-5.4",
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 300,
        },
      }),
    ])
    const pi = report.perInstance[0]
    expect(pi?.durationMs).toBe(42_000)
    expect(pi?.usage).toEqual({
      model: "gpt-5.4",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 300,
    })
  })

  test("byte-identical: absent usage/durationMs stay ABSENT (no zero-fill)", () => {
    const report = buildReport(meta, [baseResult({})])
    const pi = report.perInstance[0] as unknown as Record<string, unknown>
    // Red-on-injection: a `usage: undefined` / `durationMs: 0` regression fails here.
    expect("usage" in pi).toBe(false)
    expect("durationMs" in pi).toBe(false)
  })
})

describe("Gap 2 — UsageTap accumulates cache buckets across events", () => {
  const usageEvent = (
    u: Partial<{
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheCreationTokens: number
    }>,
  ): AgentEvent => ({
    type: "usage",
    model: "gpt-5.4",
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
    ...(u.cacheCreationTokens !== undefined ? { cacheCreationTokens: u.cacheCreationTokens } : {}),
  })

  test("sums input/output AND cacheRead/cacheCreation across multiple events", () => {
    const tap = new UsageTap()
    tap.emit(usageEvent({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 30 }))
    tap.emit(
      usageEvent({
        inputTokens: 200,
        outputTokens: 60,
        cacheReadTokens: 70,
        cacheCreationTokens: 5,
      }),
    )
    expect(tap.total()).toEqual({
      model: "gpt-5.4",
      inputTokens: 300,
      outputTokens: 100,
      cacheReadTokens: 100,
      cacheCreationTokens: 5,
    })
  })

  test("zero cache buckets are OMITTED, not emitted as 0 keys", () => {
    const tap = new UsageTap()
    tap.emit(usageEvent({ inputTokens: 10, outputTokens: 5 }))
    const total = tap.total() as unknown as Record<string, unknown>
    expect(total).toEqual({ model: "gpt-5.4", inputTokens: 10, outputTokens: 5 })
    expect("cacheReadTokens" in total).toBe(false)
    expect("cacheCreationTokens" in total).toBe(false)
  })

  test("no usage event seen → total() is undefined (byte-identical)", () => {
    expect(new UsageTap().total()).toBeUndefined()
  })
})

// ── Wiring proof — the tap the driver reads IS the tap tee'd into the consumed
// stream. This is the "wired ≠ engages" guard: a refactor that returns a FRESH
// `new UsageTap()` from buildWiring while tee-ing a different one would still pass
// the report-serialization test above, yet emit zero usage in production. Here we
// emit usage events through `wiring.stream` (what the agent loop writes to) and
// assert `wiring.usage` (what the driver reads via `.total()`) reflects them.
describe("Wiring proof — buildWiring connects the read tap to the stream tap", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wiring-usage-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const instance: Instance = {
    id: "psf__requests-9",
    repoPath: "/tmp/none",
    problemStatement: "x",
    testCmd: "true",
  }

  test("usage emitted on wiring.stream surfaces on wiring.usage.total()", () => {
    const wiring = buildWiring(instance, { dir, runId: "run-1" })
    // Observability ON ⇒ a real UsageTap must be present (not the NullStream path).
    expect(wiring.usage).toBeDefined()
    wiring.stream.emit({
      type: "usage",
      model: "gpt-5.4",
      inputTokens: 500,
      outputTokens: 120,
      cacheReadTokens: 200,
    } satisfies AgentEvent)
    wiring.stream.emit({
      type: "usage",
      model: "gpt-5.4",
      inputTokens: 300,
      outputTokens: 80,
    } satisfies AgentEvent)
    // Same object the driver reads via `args.wiring.usage?.total()`.
    expect(wiring.usage?.total()).toEqual({
      model: "gpt-5.4",
      inputTokens: 800,
      outputTokens: 200,
      cacheReadTokens: 200,
    })
  })

  test("observe OFF ⇒ no usage tap (byte-identical NullStream path)", () => {
    const wiring = buildWiring(instance, undefined)
    expect(wiring.usage).toBeUndefined()
  })
})
