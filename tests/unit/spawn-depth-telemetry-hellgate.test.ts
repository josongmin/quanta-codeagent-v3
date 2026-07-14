/**
 * HELLGATE — Phase 2 (§4.5) sub-agent nesting-control depth-flow OBSERVABILITY.
 * RFC docs/plans/jul-13-subagent-nesting-control.md rev.4 §4.5 / §8.
 *
 * Phases 0-1 (LANDED) closed the depth holes; they were only found because the
 * depth-flow was OPAQUE. Phase 2 co-locates minimal telemetry with the runner
 * reject so a future hole surfaces in metrics. This suite proves the instrument:
 *
 *   1. INVARIANT (the true production invariant): driving REAL spawn decisions
 *      through the REAL `createSubagentRunner` + the REAL `projectSpawnTools`
 *      exposure decision across {policy 1/2/3} × {depth 0..3} records a
 *      telemetry decision for EVERY attempt, and the split-brain counter
 *      (`toolExposed && denied_by_depth`) is 0 for every normal-policy case —
 *      because exposure ⇔ admission (same effectiveCap + lineage depth).
 *
 *   2. INSTRUMENT PROOF (red-on-injection): force a split-brain — a rejected
 *      depth that was WRONGLY marked `toolExposed:true` — and assert the
 *      split-brain counter goes to 1. The instrument CATCHES the exact class of
 *      bug (exposure and reject disagreeing) that let the original holes exist.
 *
 *   3. denied_by_depth records the right parent/child depths; a malformed parent
 *      depth records `denied_malformed` (from the SpawnLineageError path).
 *
 *   4. OFF/QUIET: telemetry never throws even if the record is degenerate; it is
 *      observability-only (no admit/deny behavior change — asserted by the
 *      runner's returned result matching the pre-telemetry contract).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { canExposeSpawnTools, effectiveCap } from "@/agent/spawn-depth"
import {
  __resetSpawnDepthLogSink,
  __resetSpawnDepthTelemetry,
  __setSpawnDepthLogSink,
  emitSpawnDepthDecision,
  SPAWN_DEPTH_SPLIT_BRAIN_COUNTER,
  spawnDepthSplitBrainCount,
  spawnDepthTelemetrySnapshot,
} from "@/agent/spawn-depth-telemetry"
import { createSubagentRunner } from "@/agent/subagent-runner"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { StreamPort } from "@/stream"
import type { SubagentRequest } from "@/subagent"
import { defaultTools, ToolRegistry } from "@/tool"

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A minimal VALID parent config carrying `depth` so an admitted runner spawn
 *  can build its child config without a stub crash. The injected `run`
 *  short-circuits the loop, so the LLM is never called. */
const parentAtDepth = (depth: number): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit() {} } as StreamPort,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    depth,
    llm: { model: "scripted", async *stream() {} } as unknown as LLMPort,
  }) as unknown as AgentConfig

/** A runner over the parent that never runs a real loop (completed outcome). */
const runnerAt = (depth: number, maxDepth?: number): ((r: SubagentRequest) => Promise<unknown>) =>
  createSubagentRunner(parentAtDepth(depth), {
    run: (async () => ({
      reason: "completed",
      turns: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "x" }] }],
    })) as never,
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    isGitRepo: async () => false,
  })

const setPolicy = (cap: number): void => {
  process.env["QUANTA_MAX_DESCENDANT_DEPTH"] = String(cap)
  __resetRuntimeConfig()
}
const clearPolicy = (): void => {
  delete process.env["QUANTA_MAX_DESCENDANT_DEPTH"]
  __resetRuntimeConfig()
}

beforeEach(() => {
  __resetSpawnDepthTelemetry()
})
afterEach(() => {
  clearPolicy()
  __resetSpawnDepthTelemetry()
  __resetSpawnDepthLogSink()
})

// ── 1. INVARIANT — real runner + real exposure across the matrix ──────────────

describe("§4.5 invariant — exposure ⇔ admission ⇒ split-brain is 0 (real runner)", () => {
  test("matrix {policy 1/2/3} × {depth 0..3}: every attempt records a decision; splitBrain === 0", async () => {
    let attempts = 0
    for (const policy of [1, 2, 3]) {
      setPolicy(policy)
      for (const parentDepth of [0, 1, 2, 3]) {
        __resetSpawnDepthTelemetry()
        const childDepth = parentDepth + 1
        const cap = effectiveCap(undefined) // === policy
        // The REAL exposure decision projectSpawnTools would make for this parent.
        const exposed = canExposeSpawnTools(parentDepth, cap)
        const admitted = childDepth <= cap

        const runner = runnerAt(parentDepth)
        const res = (await runner({
          prompt: "p",
          depth: childDepth,
          isolation: "none",
        } as SubagentRequest)) as { ok: boolean }

        // Observability-only: the admit/deny RESULT is unchanged by telemetry.
        expect(res.ok).toBe(admitted)

        // A decision was recorded for THIS attempt (exactly one).
        const snap = spawnDepthTelemetrySnapshot()
        const total = Object.values(snap).reduce((a, b) => a + b, 0)
        // split_brain shares the counter map, so total decisions = admitted+denied
        // counters only (split_brain is 0 here, asserted below).
        const decisions =
          (snap["agent.spawn.admission.admitted"] ?? 0) +
          (snap["agent.spawn.admission.denied_by_depth"] ?? 0) +
          (snap["agent.spawn.admission.denied_malformed"] ?? 0)
        expect(decisions).toBe(1)
        expect(total).toBe(decisions) // no stray split_brain increment

        // The decision matches the real admission.
        if (admitted) {
          expect(snap["agent.spawn.admission.admitted"]).toBe(1)
        } else {
          expect(snap["agent.spawn.admission.denied_by_depth"]).toBe(1)
        }

        // CORE INVARIANT: exposure ⇔ admission, so a denied spawn was NEVER
        // exposed ⇒ split-brain counter is 0.
        expect(exposed).toBe(admitted)
        expect(spawnDepthSplitBrainCount()).toBe(0)
        attempts += 1
      }
    }
    expect(attempts).toBe(12)
  })
})

// ── 2. INSTRUMENT PROOF — red-on-injection: force a split-brain ───────────────

describe("§4.5 instrument proof — forced split-brain bumps the counter to 1", () => {
  test("a depth-1 child WRONGLY marked toolExposed:true at a rejected depth ⇒ splitBrain 1", () => {
    // Baseline: instrument reads 0 (no split-brain on the honest path).
    expect(spawnDepthSplitBrainCount()).toBe(0)

    // INJECT the exact split-brain the invariant forbids: a spawn tool was
    // EXPOSED (`toolExposed:true`) to a parent whose child is then DENIED by
    // depth. On the real production path this record can never be produced
    // (exposure ⇔ admission); we hand-craft it to prove the instrument CATCHES
    // the desync.
    emitSpawnDepthDecision({
      parentDepth: 1,
      childDepth: 2,
      maxDescendantDepth: 1, // childDepth 2 > cap 1 ⇒ denied_by_depth
      toolExposed: true, // …yet the tool was exposed — the bug
      decision: "denied_by_depth",
    })

    // The instrument caught it.
    expect(spawnDepthSplitBrainCount()).toBe(1)
    expect(spawnDepthTelemetrySnapshot()[SPAWN_DEPTH_SPLIT_BRAIN_COUNTER]).toBe(1)

    // CONTROL: an HONEST denied_by_depth (tool NOT exposed) does NOT bump it.
    __resetSpawnDepthTelemetry()
    emitSpawnDepthDecision({
      parentDepth: 1,
      childDepth: 2,
      maxDescendantDepth: 1,
      toolExposed: false, // honest leaf: never exposed
      decision: "denied_by_depth",
    })
    expect(spawnDepthSplitBrainCount()).toBe(0)
    expect(spawnDepthTelemetrySnapshot()["agent.spawn.admission.denied_by_depth"]).toBe(1)
  })
})

// ── 3. denied depths + malformed parent depth ─────────────────────────────────

describe("§4.5 — denied_by_depth carries the right depths; malformed ⇒ denied_malformed", () => {
  test("denied_by_depth: policy 1, depth 1 child ⇒ recorded parent/child depths", async () => {
    setPolicy(1)
    const res = (await runnerAt(1)({
      prompt: "p",
      depth: 2,
      isolation: "none",
    } as SubagentRequest)) as { ok: boolean; finalText: string }
    expect(res.ok).toBe(false)
    expect(res.finalText).toContain("max subagent depth")
    const snap = spawnDepthTelemetrySnapshot()
    expect(snap["agent.spawn.admission.denied_by_depth"]).toBe(1)
    // honest reject: tool was not exposed at depth 1 under cap 1 ⇒ no split-brain.
    expect(spawnDepthSplitBrainCount()).toBe(0)
  })

  test("malformed parent depth (NaN) ⇒ denied_malformed, no throw, deny result", async () => {
    setPolicy(3)
    // Parent carries a malformed depth (NaN) — childDepthOf throws
    // SpawnLineageError, caught by the runner ⇒ denied_malformed telemetry.
    const badParent = { ...parentAtDepth(0), depth: Number.NaN } as unknown as AgentConfig
    const runner = createSubagentRunner(badParent, {
      run: (async () => ({ reason: "completed", turns: 1, messages: [] })) as never,
      isGitRepo: async () => false,
    })
    const res = (await runner({ prompt: "p", depth: 1, isolation: "none" } as SubagentRequest)) as {
      ok: boolean
      finalText: string
    }
    expect(res.ok).toBe(false)
    expect(res.finalText).toContain("spawn denied")
    const snap = spawnDepthTelemetrySnapshot()
    expect(snap["agent.spawn.admission.denied_malformed"]).toBe(1)
    // malformed is NOT a split-brain (childDepth is null / no admission compare).
    expect(spawnDepthSplitBrainCount()).toBe(0)
  })
})

// ── 4. OFF/QUIET — never throws, observability-only ───────────────────────────

describe("§4.5 — telemetry never throws and changes no admit/deny behavior", () => {
  test("emitSpawnDepthDecision never throws on any record shape", () => {
    expect(() =>
      emitSpawnDepthDecision({
        parentDepth: 0,
        childDepth: null,
        maxDescendantDepth: 0,
        toolExposed: false,
        decision: "denied_malformed",
      }),
    ).not.toThrow()
  })

  test("admit path is byte-identical result with telemetry present (observability-only)", async () => {
    setPolicy(3)
    // depth 0 child 1 <= 3 ⇒ admitted; result.ok must be exactly the pre-telemetry
    // contract (true). Telemetry recorded a decision but did not alter the result.
    const res = (await runnerAt(0)({
      prompt: "p",
      depth: 1,
      isolation: "none",
    } as SubagentRequest)) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(spawnDepthTelemetrySnapshot()["agent.spawn.admission.admitted"]).toBe(1)
    expect(spawnDepthSplitBrainCount()).toBe(0)
  })
})

// ── 5. OPERATOR-VISIBILITY (jul-15) — a split-brain surfaces WITHOUT debug ─────
//
// WHY: the split-brain counter + the `agent.spawn.admission.v1` line were read
// ONLY by tests (counter) and gated at `debug` (line), suppressed at the default
// `info` log level. So a REAL split-brain in production was operator-INVISIBLE —
// the "a future hole surfaces in metrics" promise was half-realized. This block
// pins the fix: a split-brain (and ONLY a split-brain) emits a `warn`-level
// structured line, which the default `info` threshold LETS THROUGH.

describe("§4.5 operator-visibility — split-brain emits a warn line at default (info) level", () => {
  /** Capture the structured lines emitted at the DEFAULT (info) threshold — the
   *  production log level. A `debug` line MUST NOT appear here; a `warn` line MUST. */
  const captureAtInfoLevel = (fn: () => void): Array<Record<string, unknown>> => {
    const lines: string[] = []
    // Sink installed at level "info" — the production default. If the split-brain
    // emit were `debug`-gated (the pre-fix state), nothing would land here.
    __setSpawnDepthLogSink((line) => lines.push(line), "info")
    fn()
    return lines.map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  test("RED→GREEN: forced split-brain ⇒ a warn line is visible at info level", () => {
    const records = captureAtInfoLevel(() => {
      emitSpawnDepthDecision({
        parentDepth: 1,
        childDepth: 2,
        maxDescendantDepth: 1, // 2 > cap 1 ⇒ denied_by_depth
        toolExposed: true, // …yet exposed — the split-brain the invariant forbids
        decision: "denied_by_depth",
      })
    })

    // The counter caught it (existing behavior)…
    expect(spawnDepthSplitBrainCount()).toBe(1)

    // …AND — the fix — an OPERATOR-VISIBLE warn line surfaced at the default level.
    const warns = records.filter((r) => r.level === "warn")
    expect(warns.length).toBe(1)
    const w = warns[0] as { event: string; fields: Record<string, unknown> }
    expect(w.event).toBe("agent.spawn.admission.split_brain")
    // The line carries the diagnostic depth fields for the operator.
    expect(w.fields.toolExposed).toBe(true)
    expect(w.fields.decision).toBe("denied_by_depth")
    expect(w.fields.parentDepth).toBe(1)
    expect(w.fields.childDepth).toBe(2)
    expect(w.fields.maxDescendantDepth).toBe(1)
  })

  test("PAIRED CONTROL: normal path (0 split-brain) emits NO warn line — quiet", () => {
    const records = captureAtInfoLevel(() => {
      // Honest admitted spawn.
      emitSpawnDepthDecision({
        parentDepth: 0,
        childDepth: 1,
        maxDescendantDepth: 3,
        toolExposed: true,
        decision: "admitted",
      })
      // Honest depth reject — tool was NOT exposed ⇒ not a split-brain.
      emitSpawnDepthDecision({
        parentDepth: 1,
        childDepth: 2,
        maxDescendantDepth: 1,
        toolExposed: false,
        decision: "denied_by_depth",
      })
      // Malformed parent ⇒ denied_malformed, also not a split-brain.
      emitSpawnDepthDecision({
        parentDepth: 0,
        childDepth: null,
        maxDescendantDepth: 0,
        toolExposed: false,
        decision: "denied_malformed",
      })
    })

    // No split-brain occurred…
    expect(spawnDepthSplitBrainCount()).toBe(0)
    // …so the operator surface stays SILENT: no warn line at info level.
    const warns = records.filter((r) => r.level === "warn")
    expect(warns.length).toBe(0)
    // And the per-decision `.v1` line remains debug-gated (invisible at info),
    // so the normal path produces ZERO operator noise.
    const debugLines = records.filter((r) => r.level === "debug")
    expect(debugLines.length).toBe(0)
  })
})
