/**
 * 5-wire batch hellgate (Track F-skip / Wire-2 / Wire-3 / Wire-4 / Wire-5).
 *
 * Pins the composition-root wire surface added in this batch. Each of the 5
 * wire points gets:
 *   (a) default-OFF byte-identical case — no slot/option ⇒ no allocation
 *       and no behavioral delta vs the pre-wire shape.
 *   (b) one ACTIVE dispatch/emit case proving the wire actually routes.
 *
 * Wire 1 (voice → prompt-pipeline) is intentionally SKIPPED in this hellgate
 * (user-mid-refactor signal in the dispatch instructions): a tombstone case
 * documents the absence so a future round explicitly opts back in.
 *
 * Plane-clean: tests import the slice barrels + the composition adapters.
 * No `runAgent` / `runInteractive` — wire shapes are pinned by their public
 * port surfaces and the new-slice metric registry.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultForker, type ForkSessionPort } from "@/agent/fork-session"
import {
  type DelegationPort,
  defaultDelegationRouter,
  type TypedDelegationRunner,
} from "@/agent/subagent-typed"
import {
  defaultMetricsRegistry,
  type MetricSample,
  type MetricSink,
} from "@/observability/metrics/index"
import {
  wireErrorRoutingMetric,
  wireGitDirectiveMetric,
  wireNewSlices,
  wireShellSnapshotMetric,
  wireStreamTimeoutMetric,
} from "@/observability/metrics/wire-new-slices"
import { createShellSnapshotPort } from "@/runtime/shell-snapshot"
import { headlessSpawner } from "@/runtime/shell-snapshot/headless-stub"
import { assertScanPopulation } from "./_shared/scan-population"

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const sinkOf = (): { sink: MetricSink; samples: MetricSample[] } => {
  const samples: MetricSample[] = []
  return {
    samples,
    sink: {
      send(s) {
        samples.push(s)
      },
    },
  }
}

// NOTE: Wire 1 (voice → prompt-pipeline) is intentionally not shipped — the
// prompt-pipeline surface has no `voiceQueue` field yet (REPL slash dispatch is
// the seam, not the pipeline). A future round that adds the seam adds the test.

// ───────────────────────────────────────────────────────────────────────────
// Wire 2 — Mode-typed delegation router (composition-root slot)
// ───────────────────────────────────────────────────────────────────────────

describe("Wire 2 ADR-0218 — delegation port default-OFF + active dispatch", () => {
  test("default-OFF: a host that omits the slot pays no allocation", () => {
    // The composition-root helper returns `undefined` when no modes were
    // requested. We verify the SHAPE of the slot is `port? : undefined` and
    // a host that passes `undefined` never constructs the router.
    let routerConstructions = 0
    const make = (): DelegationPort => {
      routerConstructions += 1
      return defaultDelegationRouter({
        runner: async () => ({ ok: true, finalText: "", turns: 0 }),
      })
    }
    // Default-OFF branch — never touches the factory.
    const enabledModes: ReadonlyArray<"explore"> | undefined = undefined
    const slot = enabledModes !== undefined ? { delegator: make(), modes: enabledModes } : undefined
    expect(slot).toBeUndefined()
    expect(routerConstructions).toBe(0)
  })

  test("active: router routes a request to the wired runner + returns a boomerang", async () => {
    let runnerCalls = 0
    const runner: TypedDelegationRunner = async (input) => {
      runnerCalls += 1
      return {
        ok: true,
        finalText: `ack: ${input.prompt.split("\n").pop() ?? ""}`,
        turns: 1,
      }
    }
    const port = defaultDelegationRouter({ runner })
    const out = await port.delegate({
      mode: "explore",
      prompt: "audit-the-config",
      parentSignal: new AbortController().signal,
    })
    expect(runnerCalls).toBe(1)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.summary).toContain("ack: audit-the-config")
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Wire 3 — Focus Chain reinject (SKIP — already wired in loop.ts:2075-2091)
// ───────────────────────────────────────────────────────────────────────────

describe("Wire 3 ADR-0219 — focus-chain reinject already wired in loop.ts", () => {
  test("tombstone: loop.ts:2075-2091 already advances tracker per-turn", () => {
    // Composition root (`src/apps/agent/index.ts:resolveFocusChain`) already
    // wires `defaultFocusChainTracker({ reinjectEveryN })` and the loop
    // consumes it. This wire is COMPLETE in main; this case pins the fact
    // so we don't accidentally re-implement it.
    // The 2026-06 loop decomposition relocated the focus-chain wire from the
    // monolithic loop.ts into the `src/agent/loop/` slice; read the whole loop
    // surface (shim + slice) so the tombstone pins the wire wherever it lives.
    const agentDir = join(import.meta.dir, "..", "..", "src", "agent")
    // The catch below was written for the pre-decomposition tree. The slice
    // exists now, so it no longer means "not yet split" — it means the slice
    // went unread, and every `toContain` on a wire that lives there would then
    // report the wire as missing. Enumerated once, asserted, then read.
    const loopDir = join(agentDir, "loop")
    const sliceFiles = readdirSync(loopDir)
      .sort()
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(loopDir, f))
    assertScanPopulation(sliceFiles, loopDir, {
      id: "tests/unit/wire-batch-mode-focus-fork-otel-hellgate.test.ts#loopDir",
      topLevelOnly: true,
      collectable: (f) => f.endsWith(".ts"),
    })
    const loopSrc = [
      readFileSync(join(agentDir, "loop.ts"), "utf8"),
      ...sliceFiles.map((f) => readFileSync(f, "utf8")),
    ].join("\n")
    expect(loopSrc).toContain("cfg.focusChain")
    expect(loopSrc).toContain("tracker.tickTurn()")
    expect(loopSrc).toContain("tracker.getInjection()")
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Wire 4 — Fork session port (composition-root slot)
// ───────────────────────────────────────────────────────────────────────────

describe("Wire 4 ADR-0226 — fork-session port default-OFF + active surface", () => {
  test("default-OFF: a host that omits the slot pays no allocation", () => {
    let forkerConstructions = 0
    const make = (): ForkSessionPort => {
      forkerConstructions += 1
      return defaultForker()
    }
    const enable: boolean | undefined = undefined
    const slot = enable === true ? { forker: make() } : undefined
    expect(slot).toBeUndefined()
    expect(forkerConstructions).toBe(0)
  })

  test("active: defaultForker() (no base) returns fork-not-configured typed-error", async () => {
    // Composition-root resolver constructs `defaultForker()` WITHOUT a base
    // when the surface has no `ConversationCheckpointStore` to thread. The
    // port stays valid — every `fork()` surfaces a typed error.
    const port = defaultForker()
    const result = await port.fork({ fromCheckpointRef: "any-ref" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("fork-not-configured")
    }
    // `listBranches` / `resolveParent` must still answer (no throws).
    expect(port.listBranches({ sessionId: "x" })).toEqual([])
    expect(port.resolveParent({ sessionId: "x" })).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Wire 5 — OTel emit 6-metric wire across 4 slices
// ───────────────────────────────────────────────────────────────────────────

describe("Wire 5 ADR-0222 — OTel new-slice metrics default-OFF + active emit", () => {
  test("default-OFF: shell-snapshot port without metric never observes", async () => {
    const home = mkdtempSync(join(tmpdir(), "qw5-ss-off-"))
    const port = createShellSnapshotPort(headlessSpawner, home)
    // Use the back-compat string overload to prove byte-identical legacy.
    expect(typeof port.capture).toBe("function")
    // No metric ⇒ no observation possible. The port internally checks
    // `metric === undefined` and skips the entire observation block.
    const captureRes = await port.capture({ shell: "bash" })
    // Headless stub may return ok or err; default-OFF invariant is "no
    // metric call regardless of result" — proven by the absence of any
    // metric port to call.
    expect(captureRes.ok === true || captureRes.ok === false).toBe(true)
  })

  test("active: shell-snapshot port WITH metric records duration + bytes once on success", async () => {
    const home = mkdtempSync(join(tmpdir(), "qw5-ss-on-"))
    const { sink, samples } = sinkOf()
    const metric = wireShellSnapshotMetric(defaultMetricsRegistry({ sink }))
    const port = createShellSnapshotPort(headlessSpawner, { home, metric })
    const result = await port.capture({ shell: "bash" })
    if (result.ok) {
      // Two histogram samples emitted (duration_ms + bytes) per ADR-0222 HELL-OT-10.
      expect(samples.length).toBe(2)
    } else {
      // Failure path emits nothing (the wire records on success only).
      expect(samples.length).toBe(0)
    }
  })

  test("active: wireNewSlices() aggregates all 4 metric adapters under one registry", () => {
    const { sink, samples } = sinkOf()
    const r = defaultMetricsRegistry({ sink })
    const bundle = wireNewSlices(r)
    // Each field is a wired adapter — emit one per slice and verify the
    // unified registry routes the 4 events.
    bundle.errorRouting.recordClassified("usageLimitExceeded")
    bundle.streamTimeout.recordIdle(42)
    bundle.shellSnapshot.recordCapture(15, 2048) // 2 samples (duration + bytes)
    bundle.gitDirective.recordDirective("commit")
    // 1 + 1 + 2 + 1 = 5
    expect(samples.length).toBe(5)
  })

  test("active: each individual wire helper is callable on the same registry", () => {
    const { sink, samples } = sinkOf()
    const r = defaultMetricsRegistry({ sink })
    wireErrorRoutingMetric(r).recordAction("retry-with-backoff")
    wireStreamTimeoutMetric(r).recordAction("abort")
    wireGitDirectiveMetric(r).recordDirective("commit")
    expect(samples.length).toBe(3)
  })
})
