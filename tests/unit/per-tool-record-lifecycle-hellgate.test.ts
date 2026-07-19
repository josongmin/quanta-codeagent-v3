/**
 * ★ CONTRACT — DoF-15: per-tool snapshot lifecycle bounds + producer-only
 * inspection accessor (default-OFF SOTA++ board).
 *
 * Decision (c): deliberately HOLD the live ADR-0203 per-tool producer with
 * bounded retention + a typed producer-only inspection accessor. NO second
 * snapshot authority is introduced — every assertion here runs against the
 * SAME `GranularCheckpointPolicy.registry` the dispatch wrap records into and
 * `/rewind-tool` consumes.
 *
 * DoD proven here:
 *   1. bounded retention — anchors LRU-evict past the cap (never unbounded).
 *   2. bounded call-index counter — the per-(workspace,turnId) map that
 *      supplies tag identity is ALSO capped (the pre-DoF-15 gap).
 *   3. session teardown clears ALL producer state — anchors AND counter, so
 *      a re-touched turn restarts its call-index at 0 (the pre-DoF-15 gap:
 *      `clear()` used to leave the counter behind).
 *   4. record → inspect — the typed `registry.stats()` accessor surfaces the
 *      bounded state without enumerating entries (producer-only).
 *   5. OFF path wraps ZERO tools — `wireCheckpointedEffectChannel` returns the
 *      SAME channel reference (referential identity) when no shadowCheckpoint
 *      / off-mode, so the tool-dispatch boundary is un-wrapped ⇒ no tool is
 *      snapshotted and no registry is allocated on the OFF path.
 *
 * Hermetic: hand-rolled fakes. No real git / tmpdir / loop.
 */

import { describe, expect, test } from "bun:test"
import { defaultCheckpointPolicy, type ToolResolver } from "@/agent/checkpoint-policy"
import { wireCheckpointedEffectChannel } from "@/agent/checkpoint-wiring"
import type { EffectChannel } from "@/agent/effect-channel"
import { defaultGranularCheckpointPolicy } from "@/agent/per-tool-checkpoint"
import { __test as policyTest } from "@/agent/per-tool-checkpoint/granular-policy"
import type { ShadowOdb } from "@/storage/shadow-odb"

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

const fakeOdb = (): ShadowOdb =>
  ({
    registerHead: async () => "a".repeat(40),
  }) as unknown as ShadowOdb

const buildToolPolicy = (maxRegistryEntries?: number) =>
  defaultGranularCheckpointPolicy({
    base: defaultCheckpointPolicy({ mode: "per-mutating", odb: fakeOdb() }),
    granularity: "tool",
    now: () => 42,
    ...(maxRegistryEntries !== undefined ? { maxRegistryEntries } : {}),
  })

/** Record N distinct tool anchors into `policy.registry`, each with a real
 *  toolCallId so the tag is uniquely identified. Returns the tags in order. */
const recordN = (policy: ReturnType<typeof buildToolPolicy>, n: number): string[] => {
  const tags: string[] = []
  for (let i = 0; i < n; i++) {
    const ctx = {
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      toolCallId: `call_${i}`,
    }
    const tag = policy.computeTag(ctx) as string
    policy.recordAnchorSha(tag, "b".repeat(40), ctx)
    tags.push(tag)
  }
  return tags
}

/* ================================================================== */
/* 1. bounded retention — anchors LRU-evict past cap                    */
/* ================================================================== */

describe("DoF-15 bounded retention (anchors)", () => {
  test("LIFE-1: recording past the cap evicts the OLDEST anchor (bounded, never unbounded)", () => {
    const cap = 3
    const policy = buildToolPolicy(cap)
    recordN(policy, 10) // 10 records (tags tool:edit_file:call_0..call_9), cap 3

    // Registry holds exactly `cap` — the newest 3.
    expect(policy.registry.list()).toHaveLength(cap)
    const survivors = policy.registry.list().map((e) => e.tag)
    // newest-first ordering ⇒ call_9, call_8, call_7
    expect(survivors).toEqual([
      "tool:edit_file:call_9",
      "tool:edit_file:call_8",
      "tool:edit_file:call_7",
    ])
    // Oldest (call_0) was evicted — lookup miss proves it's gone (real effect).
    expect(policy.registry.lookup("tool:edit_file:call_0")).toBeNull()
    expect(policy.registry.lookup("tool:edit_file:call_9")).not.toBeNull()
  })

  test("LIFE-2: stats().entryCount tracks the live bounded size AND never exceeds entryCap", () => {
    const policy = buildToolPolicy(4)
    recordN(policy, 25)
    const s = policy.registry.stats()
    expect(s.entryCount).toBe(4)
    expect(s.entryCount).toBeLessThanOrEqual(s.entryCap)
    expect(s.entryCap).toBe(4)
  })
})

/* ================================================================== */
/* 2. bounded call-index counter (the pre-DoF-15 gap)                   */
/* ================================================================== */

describe("DoF-15 bounded call-index counter", () => {
  test("LIFE-3: the per-(workspace,turnId) counter is LRU-capped — cannot grow unbounded", () => {
    // buildCallIndexCounter now takes an explicit cap. Drive far past it.
    const counter = policyTest.buildCallIndexCounter(5)
    for (let i = 0; i < 500; i++) counter.next("/ws", `turn-${i}`)
    // Only the newest 5 (workspace,turnId) keys survive.
    expect(counter.size()).toBe(5)
  })

  test("LIFE-4: default counter cap is exposed + a real policy's counter tracks distinct turns", () => {
    expect(policyTest.DEFAULT_MAX_CALL_INDEX_KEYS).toBeGreaterThan(0)
    const policy = buildToolPolicy()
    // compute (no toolCallId ⇒ counter is the identity source) for 3 turns.
    policy.computeTag({ workspace: "/ws", turnId: "t1", toolName: "e" })
    policy.computeTag({ workspace: "/ws", turnId: "t2", toolName: "e" })
    policy.computeTag({ workspace: "/ws", turnId: "t3", toolName: "e" })
    expect(policy.registry.stats().counterCount).toBe(3)
  })
})

/* ================================================================== */
/* 3. session teardown clears ALL producer state                       */
/* ================================================================== */

describe("DoF-15 teardown clears ALL producer state", () => {
  test("LIFE-5: clear() drops anchors AND resets the counter (re-touched turn restarts at idx 0)", () => {
    const policy = buildToolPolicy()
    // Advance the counter for turn-0 (no toolCallId ⇒ counter-sourced index).
    const first = policy.computeTag({ workspace: "/ws", turnId: "turn-0", toolName: "edit_file" })
    expect(first).toBe("tool:edit_file:turn-0:0")
    const second = policy.computeTag({ workspace: "/ws", turnId: "turn-0", toolName: "edit_file" })
    expect(second).toBe("tool:edit_file:turn-0:1") // counter advanced

    // Also seed some anchors.
    recordN(policy, 5)
    expect(policy.registry.list().length).toBeGreaterThan(0)
    expect(policy.registry.stats().counterCount).toBeGreaterThan(0)

    // Session teardown.
    policy.registry.clear()

    // Anchors gone.
    expect(policy.registry.list()).toEqual([])
    // Counter reset — the SAME turn now restarts at idx 0 (pre-DoF-15 this
    // returned idx 1 because clear() left the counter behind).
    expect(policy.registry.stats().counterCount).toBe(0)
    const afterClear = policy.computeTag({
      workspace: "/ws",
      turnId: "turn-0",
      toolName: "edit_file",
    })
    expect(afterClear).toBe("tool:edit_file:turn-0:0")
  })

  test("LIFE-6: red-on-injection — a clear() that forgot the counter would leak (guards the fix)", () => {
    // This models the OLD broken behaviour: a registry whose clear only wipes
    // entries. We simulate it and assert our REAL policy does NOT behave that
    // way (paired control).
    const brokenCounter = policyTest.buildCallIndexCounter(1000)
    brokenCounter.next("/ws", "turn-x") // size 1
    // A "clear" that forgets the counter leaves size 1 — the bug.
    // (no reset call) — assert the leaked state is observable.
    expect(brokenCounter.size()).toBe(1)
    // The REAL policy resets it:
    const policy = buildToolPolicy()
    policy.computeTag({ workspace: "/ws", turnId: "turn-x", toolName: "e" })
    expect(policy.registry.stats().counterCount).toBe(1)
    policy.registry.clear()
    expect(policy.registry.stats().counterCount).toBe(0)
  })
})

/* ================================================================== */
/* 4. record → inspect (typed producer-only accessor)                  */
/* ================================================================== */

describe("DoF-15 record → inspect proof", () => {
  test("LIFE-7: stats() is a typed producer-only projection over the SAME store", () => {
    const policy = buildToolPolicy(50)
    // empty before any record
    const empty = policy.registry.stats()
    expect(empty.entryCount).toBe(0)
    expect(empty.counterCount).toBe(0)

    recordN(policy, 7)
    const s = policy.registry.stats()
    // The typed accessor reports the SAME count list() would, without
    // enumerating (record→inspect).
    expect(s.entryCount).toBe(policy.registry.list().length)
    expect(s.entryCount).toBe(7)
    // caps are surfaced so a telemetry surface can render "N/cap".
    expect(s.entryCap).toBe(50)
    expect(s.counterCap).toBe(policyTest.DEFAULT_MAX_CALL_INDEX_KEYS)
  })

  test("LIFE-8: inspect is NOT a second authority — list()/lookup()/stats() agree on the SAME entries", () => {
    const policy = buildToolPolicy()
    const tags = recordN(policy, 3)
    for (const tag of tags) {
      expect(policy.registry.lookup(tag)).not.toBeNull()
    }
    expect(policy.registry.stats().entryCount).toBe(policy.registry.list().length)
    expect(
      policy.registry
        .list()
        .map((e) => e.tag)
        .sort(),
    ).toEqual([...tags].sort())
  })
})

/* ================================================================== */
/* 5. OFF path wraps ZERO tools (paired control)                       */
/* ================================================================== */

describe("DoF-15 OFF path wraps zero tools", () => {
  const sentinelChannel = (): EffectChannel =>
    ({
      execute: async () => {
        throw new Error("sentinel: should never dispatch in these wiring tests")
      },
    }) as unknown as EffectChannel

  const resolver: ToolResolver = () => undefined

  test("OFF-1: shadowCheckpoint ABSENT ⇒ wire returns the SAME channel (zero wrap, zero registry)", () => {
    const inner = sentinelChannel()
    const wired = wireCheckpointedEffectChannel(inner, {}, resolver)
    // Referential identity ⇒ NO wrap object was constructed ⇒ the tool
    // dispatch boundary is un-wrapped ⇒ zero tools are snapshotted.
    expect(wired).toBe(inner)
  })

  test("OFF-2: mode 'off' ⇒ wire returns the SAME channel (paired control vs a real config)", () => {
    const inner = sentinelChannel()
    const odb = fakeOdb()
    const off = wireCheckpointedEffectChannel(
      inner,
      { shadowOdb: odb, shadowCheckpoint: { mode: "off" } },
      resolver,
    )
    expect(off).toBe(inner) // OFF ⇒ identity

    // PAIRED CONTROL: a live config DOES wrap (different reference) — proves
    // the OFF identity above is meaningful, not vacuous.
    const on = wireCheckpointedEffectChannel(
      inner,
      { shadowOdb: odb, shadowCheckpoint: { mode: "per-mutating" } },
      resolver,
    )
    expect(on).not.toBe(inner)
  })

  test("OFF-3: shadowOdb absent (checkpoint present) ⇒ still identity (no place to anchor)", () => {
    const inner = sentinelChannel()
    const wired = wireCheckpointedEffectChannel(
      inner,
      { shadowCheckpoint: { mode: "per-mutating" } },
      resolver,
    )
    expect(wired).toBe(inner)
  })
})
