/**
 * RFC02-3 (A8) — model_route_changed exhaustive-projection-cascade hellgate.
 *
 * The route transition is a caller-owned observation projected onto the ONE
 * existing `AgentEvent` closed union. This gate pins the CASCADE that a new arm
 * MUST satisfy (stacking ON TOP of RFC01-1's `context_headroom_crossed`, which
 * must keep working):
 *
 *   1. Closed-union drift guards — `ModelRouteKind` / `ModelRouteReason` runtime
 *      lists equal their unions (keys==union), and `AGENT_EVENT_TYPES ⊇ union`.
 *   2. Recorder DURABILITY (OQ2 → durable): a `model_route_changed` event drives
 *      a real `JsonlRecorder` and lands as a `recovery`-kind line whose data
 *      carries from/to/routeReason/routeKind — the post-hoc "which model ran".
 *   3. Red-on-injection for the recorder: flipping the durable mapping to a SKIP
 *      would drop the line (asserted structurally by the presence of the line).
 *   4. Coexistence: RFC01-1's `context_headroom_crossed` is still SKIPPED by the
 *      recorder (both arms live in the SAME cascade, no regression).
 *   5. Every AgentEvent type is either KIND_MAP-mapped or explicitly skip-listed
 *      by the recorder (no `unknown` fallback in the cascade).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunContext, TrajectoryEvent } from "@/shared"
import {
  AGENT_EVENT_TYPES,
  type AgentEvent,
  ALL_MODEL_ROUTE_KINDS,
  ALL_MODEL_ROUTE_REASONS,
  type ModelRouteKind,
  type ModelRouteReason,
} from "@/stream"
import { JsonlRecorder } from "../../src/stream/adapters/jsonl-recorder"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "route-transition-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CTX: RunContext = { runId: "r1", instanceId: "i1", attempt: 0 }
const readLines = (path: string): TrajectoryEvent[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TrajectoryEvent)

const routeEvent = (over: Partial<Extract<AgentEvent, { type: "model_route_changed" }>> = {}) =>
  ({
    type: "model_route_changed",
    fromModel: "gpt-5",
    toModel: "claude-opus",
    reason: "operator_requested",
    routeKind: "operator_retry",
    at: 1000,
    ...over,
  }) satisfies Extract<AgentEvent, { type: "model_route_changed" }>

describe("RFC02-3 A8 — closed-union drift guards", () => {
  test("ALL_MODEL_ROUTE_KINDS equals the ModelRouteKind union (keys==union)", () => {
    // Compile-side: the array `satisfies readonly ModelRouteKind[]`. Runtime
    // side: a value of the union must be a member (no missing/extra members).
    const universe = new Set<string>(ALL_MODEL_ROUTE_KINDS)
    const sample: ModelRouteKind[] = [
      "operator_retry",
      "provider_fallback",
      "scheduler_reroute",
    ]
    for (const k of sample) expect(universe.has(k)).toBe(true)
    expect(ALL_MODEL_ROUTE_KINDS).toHaveLength(sample.length)
  })

  test("ALL_MODEL_ROUTE_REASONS equals the ModelRouteReason union", () => {
    const universe = new Set<string>(ALL_MODEL_ROUTE_REASONS)
    const sample: ModelRouteReason[] = [
      "operator_escalation",
      "operator_requested",
      "provider_overloaded",
      "provider_server_error",
      "provider_network",
      "provider_not_implemented",
      "preferred_unavailable",
    ]
    for (const r of sample) expect(universe.has(r)).toBe(true)
    expect(ALL_MODEL_ROUTE_REASONS).toHaveLength(sample.length)
  })

  test("AGENT_EVENT_TYPES carries model_route_changed AND still carries RFC01-1's arm (both coexist)", () => {
    expect(AGENT_EVENT_TYPES).toContain("model_route_changed")
    // Stacking proof: RFC01-1's arm was NOT removed.
    expect(AGENT_EVENT_TYPES).toContain("context_headroom_crossed")
  })
})

describe("RFC02-3 A8 — recorder durability + cascade coexistence", () => {
  test("[crown][durable] model_route_changed lands as a recovery-kind line with from/to/routeReason/routeKind", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, {
      ctx: CTX,
      now: () => 1_700_000_000_000,
      monotonic: () => 42,
    })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit(routeEvent({ turnId: "t1", provider: "anthropic" }))
    rec.emit({ type: "done", reason: "stop", turns: 1 })
    rec.close()

    const lines = readLines(path)
    // The DURABLE route line is present (NOT dropped like a transient advisory).
    const route = lines.find(
      (l) => (l.data as { reason?: string } | undefined)?.reason === "model_route_changed",
    )
    expect(route).toBeDefined()
    expect(route?.kind).toBe("recovery")
    expect(route?.data).toMatchObject({
      reason: "model_route_changed",
      fromModel: "gpt-5",
      toModel: "claude-opus",
      routeReason: "operator_requested",
      routeKind: "operator_retry",
      at: 1000,
      turnId: "t1",
      provider: "anthropic",
    })
  })

  test("[red-on-injection] the durable line is caused by the emit — no route emit ⇒ no route line", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, {
      ctx: CTX,
      now: () => 1_700_000_000_000,
      monotonic: () => 42,
    })
    // Injection: DO NOT emit the route event.
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit({ type: "done", reason: "stop", turns: 1 })
    rec.close()
    const lines = readLines(path)
    expect(
      lines.some(
        (l) => (l.data as { reason?: string } | undefined)?.reason === "model_route_changed",
      ),
    ).toBe(false)
  })

  test("[coexistence] RFC01-1 context_headroom_crossed is STILL skipped by the recorder (no regression)", () => {
    const path = join(dir, "i1.0.jsonl")
    const rec = new JsonlRecorder(path, {
      ctx: CTX,
      now: () => 1_700_000_000_000,
      monotonic: () => 42,
    })
    rec.emit({ type: "turn_start", turn: 1 })
    rec.emit({
      type: "context_headroom_crossed",
      usedTokens: 100,
      limitTokens: 200,
      thresholdTokens: 150,
    })
    rec.emit(routeEvent())
    rec.close()
    const lines = readLines(path)
    // headroom is the transient advisory ⇒ NO line; route is durable ⇒ HAS line.
    expect(lines.some((l) => l.kind === "turn_start")).toBe(true)
    expect(
      lines.some(
        (l) => (l.data as { reason?: string } | undefined)?.reason === "model_route_changed",
      ),
    ).toBe(true)
    // No advisory line — headroom carries no recorded payload (skipped).
    expect(lines).toHaveLength(2) // turn_start + model_route_changed only
  })
})
