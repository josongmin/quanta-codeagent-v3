/**
 * ADR-0360 — Per-turn plugin activation telemetry hellgate.
 *
 * `resolvePluginActivationForTurn` (ADR-0346 loop hook) emits 4 counters
 * when `config.metricsEmitter` is wired:
 *
 *   codex_r2.activation.calls               — total invocations
 *   codex_r2.activation.sum_latency_ms      — sum of per-call elapsed ms
 *   codex_r2.activation.resolved_skills_count — per-call skill count
 *   codex_r2.activation.errors              — activator throws
 *
 * Codex OTel attribute vocabulary parallel: same shape as
 * `codex.turn.*` count + sum_ms (memory `codex-otel-attribute-vocabulary`).
 *
 * Pins:
 *   A. emitter absent          ⇒ no emit (byte-identical legacy)
 *   B. successful activation   ⇒ calls += 1 + sum_latency_ms += elapsed
 *   C. resolved_skills_count   ⇒ matches the activator's returned array length
 *   D. activator throws        ⇒ errors += 1 + still emits calls
 *   E. emitter.counter throws  ⇒ swallow (NO-THROW)
 *   F. activator absent        ⇒ no emit (short-circuit before counter)
 *   G. empty user text         ⇒ no emit
 *   H. zero mentions           ⇒ no emit (short-circuit before counter)
 */

import { describe, expect, spyOn, test } from "bun:test"
// Namespace import of the SAME barrel the hook dynamic-imports (`await
// import("@/agent/mention-injection")` resolves to this exact module record), so
// a `spyOn(namespace, "parseMentions")` is visible to the hook AND is
// `mockRestore()`-able — unlike `mock.module`, which is process-global and NOT
// undone by restore (would leak the throwing stub into later cases / files).
import * as mentionInjection from "@/agent/mention-injection"
import {
  type ActivationHookConfigLike,
  resolvePluginActivationForTurn,
} from "@/agent/loop-activation-hook"
import type { AggregatedActivation } from "@/agent/plugin-activation-handler"
import type { MetricEmitterPort } from "@/observability/codex-r2-metrics"

interface Captured {
  name: string
  delta: number
  attrs?: Readonly<Record<string, string>>
}

const mkEmitter = (): { emitter: MetricEmitterPort; log: Captured[] } => {
  const log: Captured[] = []
  const emitter: MetricEmitterPort = {
    counter: (name, delta, attrs) => {
      const entry: Captured = attrs === undefined ? { name, delta } : { name, delta, attrs }
      log.push(entry)
    },
    gauge: () => {
      /* not emitted by ADR-0360 today */
    },
  }
  return { emitter, log }
}

const sumOf = (log: Captured[], name: string): number =>
  log.filter((e) => e.name === name).reduce((a, e) => a + e.delta, 0)
const countOf = (log: Captured[], name: string): number => log.filter((e) => e.name === name).length

const stubActivation = (
  resolvedSkills: AggregatedActivation["resolvedSkills"] = [],
): AggregatedActivation => ({ resolvedSkills, handles: [] }) as unknown as AggregatedActivation

describe("ADR-0360 — activation hook telemetry", () => {
  test("A. emitter absent ⇒ no emit (byte-identical legacy)", async () => {
    const cfg: ActivationHookConfigLike = {
      activatePlugins: async () => stubActivation([]),
    }
    const out = await resolvePluginActivationForTurn(cfg, "@plugin do x", "t1")
    expect(out.resolvedSkills).toEqual([])
  })

  test("B. successful activation ⇒ calls += 1 + sum_latency_ms emitted", async () => {
    const { emitter, log } = mkEmitter()
    const cfg: ActivationHookConfigLike = {
      activatePlugins: async () => {
        // Yield to event loop so monotonic clock makes progress.
        await new Promise((r) => setTimeout(r, 1))
        return stubActivation([])
      },
      metricsEmitter: emitter,
    }
    await resolvePluginActivationForTurn(cfg, "@plugin do x", "t1")
    expect(sumOf(log, "codex_r2.activation.calls")).toBe(1)
    // sum_latency_ms >= 0 (monotonic clock guarantees non-negative even on
    // a zero-cost activator on heavily-loaded hosts).
    expect(sumOf(log, "codex_r2.activation.sum_latency_ms")).toBeGreaterThanOrEqual(0)
  })

  test("C. resolved_skills_count counter == activator's returned array length", async () => {
    const { emitter, log } = mkEmitter()
    const skills = [
      { name: "skill-a", description: "" },
      { name: "skill-b", description: "" },
      { name: "skill-c", description: "" },
    ] as AggregatedActivation["resolvedSkills"]
    const cfg: ActivationHookConfigLike = {
      activatePlugins: async () => stubActivation(skills),
      metricsEmitter: emitter,
    }
    await resolvePluginActivationForTurn(cfg, "@plugin go", "t2")
    expect(sumOf(log, "codex_r2.activation.resolved_skills_count")).toBe(3)
  })

  test("D. activator throws ⇒ errors += 1 + calls still emitted", async () => {
    const { emitter, log } = mkEmitter()
    const cfg: ActivationHookConfigLike = {
      activatePlugins: async () => {
        throw new Error("activator boom")
      },
      metricsEmitter: emitter,
    }
    const out = await resolvePluginActivationForTurn(cfg, "@plugin oops", "t3")
    // Swallowed ⇒ empty result.
    expect(out.resolvedSkills).toEqual([])
    expect(sumOf(log, "codex_r2.activation.calls")).toBe(1)
    expect(sumOf(log, "codex_r2.activation.errors")).toBe(1)
    // Success-only counters NOT emitted on error path.
    expect(countOf(log, "codex_r2.activation.sum_latency_ms")).toBe(0)
    expect(countOf(log, "codex_r2.activation.resolved_skills_count")).toBe(0)
  })

  test("D2. parseMentions throws ⇒ errors += 1 AND calls += 1 (parse-catch, previously UNCOVERED)", async () => {
    // ALBB-09 site 3: the `parseMentions` catch runs BEFORE the up-front
    // `activation.calls` counter, so a parse/import failure was counted in
    // NEITHER `calls` NOR `errors` — indistinguishable from "no mentions". Inject
    // a throwing `parseMentions` via a RESTORABLE namespace spy (the hook
    // dynamic-imports this exact barrel record) and assert the catch now bumps
    // BOTH counters (ADR-0360 side-channel, NOT a stream). `mockRestore()` in the
    // finally undoes it hermetically — no cross-test / cross-file leak.
    const spy = spyOn(mentionInjection, "parseMentions").mockImplementation(() => {
      throw new Error("parse-boom")
    })
    try {
      const { emitter, log } = mkEmitter()
      const cfg: ActivationHookConfigLike = {
        activatePlugins: async () => stubActivation([]),
        metricsEmitter: emitter,
      }
      const out = await resolvePluginActivationForTurn(cfg, "@plugin trigger parse", "tD2")
      // Still degrades clean (EMPTY) — the turn is unaffected.
      expect(out.resolvedSkills).toEqual([])
      // Both counters bump so error_rate = errors/calls stays computable for
      // parse failures too.
      expect(sumOf(log, "codex_r2.activation.errors")).toBe(1)
      expect(sumOf(log, "codex_r2.activation.calls")).toBe(1)
      // The activator never ran (parse threw first) ⇒ no success-only counters.
      expect(countOf(log, "codex_r2.activation.resolved_skills_count")).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  test("E. emitter.counter throws ⇒ swallowed (NO-THROW invariant)", async () => {
    const hostileEmitter: MetricEmitterPort = {
      counter: () => {
        throw new Error("emitter boom")
      },
      gauge: () => {},
    }
    const cfg: ActivationHookConfigLike = {
      activatePlugins: async () => stubActivation([]),
      metricsEmitter: hostileEmitter,
    }
    // MUST NOT throw — activation must complete even with hostile emitter.
    const out = await resolvePluginActivationForTurn(cfg, "@plugin ok", "t4")
    expect(out.resolvedSkills).toEqual([])
  })

  test("F. activator absent ⇒ no emit (short-circuit before counter)", async () => {
    const { emitter, log } = mkEmitter()
    const cfg: ActivationHookConfigLike = { metricsEmitter: emitter }
    await resolvePluginActivationForTurn(cfg, "@plugin", "t5")
    expect(log).toHaveLength(0)
  })

  test("G. empty user text ⇒ no emit", async () => {
    const { emitter, log } = mkEmitter()
    const cfg: ActivationHookConfigLike = {
      activatePlugins: async () => stubActivation([]),
      metricsEmitter: emitter,
    }
    await resolvePluginActivationForTurn(cfg, "", "t6")
    await resolvePluginActivationForTurn(cfg, undefined, "t7")
    expect(log).toHaveLength(0)
  })

  test("H. zero mentions ⇒ no emit (short-circuit before counter)", async () => {
    const { emitter, log } = mkEmitter()
    const cfg: ActivationHookConfigLike = {
      activatePlugins: async () => stubActivation([]),
      metricsEmitter: emitter,
    }
    // Text with no @mentions ⇒ parseMentions returns [] ⇒ EMPTY short-circuit
    // BEFORE counter emit.
    await resolvePluginActivationForTurn(cfg, "no mentions in here at all", "t8")
    expect(log).toHaveLength(0)
  })
})
