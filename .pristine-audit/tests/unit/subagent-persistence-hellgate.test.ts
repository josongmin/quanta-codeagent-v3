/**
 * BackgroundSubagentScheduler cross-restart persistence — hellgate (ADR-0153).
 *
 * Seals serialize/hydrate + auto-hydrate factory opt + disk-backed helpers.
 * Voice-match ADR-0124 (conversation-checkpoint) + ADR-0136 (budget-ledger)
 * serialize/hydrate posture: NO-THROW on garbage input, exactOptional fields
 * round-trip cleanly, running entries reborn as "lost across restart" since
 * the Promise object cannot be reconstructed.
 *
 * Sections:
 *   A. serialize/hydrate roundtrip (5)
 *   B. hydrateWithPrune (3)
 *   C. Auto-restore on construction (2)
 *   D. snapshotToFile / restoreFromFile (2)
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type BackgroundSubagentScheduler,
  defaultBackgroundSubagentScheduler,
} from "@/agent/subagent-background"
import { readSnapshotFile, restoreFromFile, snapshotToFile } from "@/agent/subagent-persistence"
import type { SubagentResult as SliceResult, SubagentRunner } from "@/subagent"

/** A runner whose completion is externally controlled. Single-shot resolve. */
const controlledRunner = (): {
  runner: SubagentRunner
  resolve: (out: SliceResult) => void
  reject: (e: Error) => void
} => {
  let resolveFn: ((out: SliceResult) => void) | null = null
  let rejectFn: ((e: Error) => void) | null = null
  const runner: SubagentRunner = () =>
    new Promise<SliceResult>((res, rej) => {
      resolveFn = res
      rejectFn = rej
    })
  return {
    runner,
    resolve: (out) => {
      if (resolveFn) resolveFn(out)
    },
    reject: (e) => {
      if (rejectFn) rejectFn(e)
    },
  }
}

/** Drain microtasks. */
const yieldMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** Multi-fork runner factory — returns per-fork resolve handles. */
const multiSlotRunner = (): {
  runner: SubagentRunner
  slots: Array<(out: SliceResult) => void>
} => {
  const slots: Array<(out: SliceResult) => void> = []
  const runner: SubagentRunner = () =>
    new Promise<SliceResult>((res) => {
      slots.push(res)
    })
  return { runner, slots }
}

/** Fresh scheduler with hydrateFrom optional. */
const freshScheduler = (
  hydrateFrom?: string,
  hydrateMaxAgeMs?: number,
  now?: () => number,
): BackgroundSubagentScheduler => {
  const { runner } = controlledRunner()
  return defaultBackgroundSubagentScheduler({
    runner,
    ...(hydrateFrom !== undefined ? { hydrateFrom } : {}),
    ...(hydrateMaxAgeMs !== undefined ? { hydrateMaxAgeMs } : {}),
    ...(now !== undefined ? { now } : {}),
  })
}

// ─────────────────────────────────────────────────────────────
// A. serialize/hydrate roundtrip (5)
// ─────────────────────────────────────────────────────────────

describe("Subagent persistence — A. serialize/hydrate roundtrip", () => {
  test("HELL-P1: fork 3 + complete 2 → serialize → hydrate FRESH scheduler → 3 entries", async () => {
    const { runner, slots } = multiSlotRunner()
    const src = defaultBackgroundSubagentScheduler({ runner, maxConcurrent: 5 })
    const id1 = src.fork({ task: "alpha" })
    const id2 = src.fork({ task: "beta" })
    const id3 = src.fork({ task: "gamma" })
    // Complete the first two via slot resolves.
    slots[0]?.({ ok: true, finalText: "alpha-done", turns: 1 })
    slots[1]?.({ ok: true, finalText: "beta-done", turns: 2 })
    await yieldMicrotasks()
    const json = src.serialize()
    // Brand-new scheduler — no shared state with `src`.
    const fresh = freshScheduler()
    const restored = fresh.hydrate(json)
    expect(restored).toBe(3)
    expect(fresh.poll(id1)?.status).toBe("completed")
    expect(fresh.poll(id1)?.outputDetail).toBe("alpha-done")
    expect(fresh.poll(id2)?.status).toBe("completed")
    expect(fresh.poll(id2)?.outputDetail).toBe("beta-done")
    // id3 was still running — reborn as failed-lost.
    expect(fresh.poll(id3)?.status).toBe("failed")
    expect(fresh.poll(id3)?.errorMessage).toBe("lost across restart")
    // Cleanup: resolve the 3rd slot so we don't leak.
    slots[2]?.({ ok: true, finalText: "gamma-done", turns: 3 })
  })

  test("HELL-P2: running entry → serialize → hydrate → reborn as failed + 'lost across restart'", async () => {
    const { runner } = controlledRunner()
    const src = defaultBackgroundSubagentScheduler({ runner })
    const id = src.fork({ task: "long-running" })
    // Serialize while still running.
    const json = src.serialize()
    const fresh = freshScheduler()
    const restored = fresh.hydrate(json)
    expect(restored).toBe(1)
    const snap = fresh.poll(id)
    expect(snap?.status).toBe("failed")
    expect(snap?.errorMessage).toBe("lost across restart")
    expect(snap?.endedAt).toBeDefined()
    expect(snap?.outputSummary).toContain("lost across restart")
  })

  test("HELL-P3: spec preserved across roundtrip (task, modelOverride, metadata)", async () => {
    const { runner } = controlledRunner()
    const src = defaultBackgroundSubagentScheduler({ runner })
    const id = src.fork({
      task: "review PR #42",
      modelOverride: "claude-opus-4-7",
      maxTurns: 12,
      workspace: "/tmp/work",
      metadata: { origin: "ci", priority: "high" },
    })
    const json = src.serialize()
    const fresh = freshScheduler()
    fresh.hydrate(json)
    const entries = fresh.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe(id)
    expect(entries[0]?.spec.task).toBe("review PR #42")
    expect(entries[0]?.spec.modelOverride).toBe("claude-opus-4-7")
    expect(entries[0]?.spec.maxTurns).toBe(12)
    expect(entries[0]?.spec.workspace).toBe("/tmp/work")
    expect(entries[0]?.spec.metadata).toEqual({ origin: "ci", priority: "high" })
  })

  test("HELL-P4: empty scheduler → serialize → hydrate → 0 entries restored", () => {
    const { runner } = controlledRunner()
    const src = defaultBackgroundSubagentScheduler({ runner })
    const json = src.serialize()
    const fresh = freshScheduler()
    const restored = fresh.hydrate(json)
    expect(restored).toBe(0)
    expect(fresh.list()).toHaveLength(0)
  })

  test("HELL-P5: malformed JSON → hydrate returns 0 (NO-THROW)", () => {
    const fresh = freshScheduler()
    // Garbage strings, wrong shape, wrong version — all return 0 silently.
    expect(fresh.hydrate("not-json{{{")).toBe(0)
    expect(fresh.hydrate("null")).toBe(0)
    expect(fresh.hydrate("[]")).toBe(0)
    expect(fresh.hydrate(JSON.stringify({ v: 2, handles: [] }))).toBe(0)
    expect(fresh.hydrate(JSON.stringify({ v: 1, handles: "not-array" }))).toBe(0)
    expect(fresh.list()).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────
// B. hydrateWithPrune (3)
// ─────────────────────────────────────────────────────────────

describe("Subagent persistence — B. hydrateWithPrune", () => {
  test("HELL-P6: maxAgeMs filter — only fresh entries restored", async () => {
    // Source scheduler with a pinned clock so we control endedAt.
    let nowMs = 1_000_000
    const { runner } = controlledRunner()
    const src = defaultBackgroundSubagentScheduler({ runner, now: () => nowMs })
    const idOld = src.fork({ task: "old" })
    src.cancel(idOld) // endedAt = 1_000_000
    nowMs = 1_001_500
    const { runner: r2 } = controlledRunner()
    const src2 = defaultBackgroundSubagentScheduler({ runner: r2, now: () => nowMs })
    const idFresh = src2.fork({ task: "fresh" })
    src2.cancel(idFresh) // endedAt = 1_001_500
    // Merge the two serialized states into one payload manually so we can
    // hydrate both into a fresh scheduler.
    const j1 = JSON.parse(src.serialize()) as { v: 1; handles: unknown[] }
    const j2 = JSON.parse(src2.serialize()) as { v: 1; handles: unknown[] }
    const merged = JSON.stringify({ v: 1, handles: [...j1.handles, ...j2.handles] })
    // Hydrate at t=1_002_000 with maxAgeMs=1000 → cutoff=1_001_000.
    // - idOld endedAt=1_000_000 < cutoff → DROPPED
    // - idFresh endedAt=1_001_500 >= cutoff → KEPT
    const tHydrate = 1_002_000
    const fresh = freshScheduler(undefined, undefined, () => tHydrate)
    const { restored, pruned } = fresh.hydrateWithPrune(merged, 1000)
    expect(restored).toBe(1)
    expect(pruned).toBe(1)
    expect(fresh.poll(idOld)).toBeNull()
    expect(fresh.poll(idFresh)?.status).toBe("cancelled")
  })

  test("HELL-P7: all entries within age → restored = count, pruned = 0", async () => {
    let nowMs = 5_000_000
    const { runner, slots } = multiSlotRunner()
    const src = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 5,
      now: () => nowMs,
    })
    src.fork({ task: "a" })
    src.fork({ task: "b" })
    slots[0]?.({ ok: true, finalText: "a-done", turns: 1 })
    slots[1]?.({ ok: true, finalText: "b-done", turns: 1 })
    await yieldMicrotasks()
    // All endedAt == 5_000_000. Hydrate at 5_000_500 with maxAgeMs 10000 →
    // cutoff 4_990_500, both survive.
    nowMs = 5_000_500
    const json = src.serialize()
    const fresh = freshScheduler(undefined, undefined, () => 5_000_500)
    const { restored, pruned } = fresh.hydrateWithPrune(json, 10_000)
    expect(restored).toBe(2)
    expect(pruned).toBe(0)
  })

  test("HELL-P8: all entries past age → restored = 0, pruned = count", async () => {
    let nowMs = 100
    const { runner, slots } = multiSlotRunner()
    const src = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 5,
      now: () => nowMs,
    })
    src.fork({ task: "a" })
    src.fork({ task: "b" })
    src.fork({ task: "c" })
    slots[0]?.({ ok: true, finalText: "x", turns: 1 })
    slots[1]?.({ ok: true, finalText: "y", turns: 1 })
    slots[2]?.({ ok: true, finalText: "z", turns: 1 })
    await yieldMicrotasks()
    nowMs = 1_000_000_000
    const json = src.serialize()
    // Hydrate at t=1e9 with maxAgeMs=100 → cutoff = 999_999_900. All
    // endedAt = 100 << cutoff → all dropped.
    const fresh = freshScheduler(undefined, undefined, () => 1_000_000_000)
    const { restored, pruned } = fresh.hydrateWithPrune(json, 100)
    expect(restored).toBe(0)
    expect(pruned).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────
// C. Auto-restore on construction (2)
// ─────────────────────────────────────────────────────────────

describe("Subagent persistence — C. auto-restore on construction", () => {
  test("HELL-P9: hydrateFrom set → entries appear in list()", async () => {
    const { runner, slots } = multiSlotRunner()
    const src = defaultBackgroundSubagentScheduler({ runner, maxConcurrent: 5 })
    src.fork({ task: "x" })
    src.fork({ task: "y" })
    slots[0]?.({ ok: true, finalText: "x-done", turns: 1 })
    slots[1]?.({ ok: true, finalText: "y-done", turns: 2 })
    await yieldMicrotasks()
    const json = src.serialize()
    // Brand-new scheduler hydrates from `json` AT CONSTRUCTION.
    const { runner: r2 } = controlledRunner()
    const fresh = defaultBackgroundSubagentScheduler({ runner: r2, hydrateFrom: json })
    expect(fresh.list()).toHaveLength(2)
    const tasks = new Set(fresh.list().map((e) => e.spec.task))
    expect(tasks).toEqual(new Set(["x", "y"]))
  })

  test("HELL-P10: hydrateFrom + hydrateMaxAgeMs → old pruned, fresh restored", async () => {
    let nowMs = 0
    const { runner: rOld } = controlledRunner()
    const srcOld = defaultBackgroundSubagentScheduler({ runner: rOld, now: () => nowMs })
    const idOld = srcOld.fork({ task: "stale" })
    srcOld.cancel(idOld) // endedAt = 0
    nowMs = 5000
    const { runner: rNew } = controlledRunner()
    const srcNew = defaultBackgroundSubagentScheduler({ runner: rNew, now: () => nowMs })
    const idNew = srcNew.fork({ task: "recent" })
    srcNew.cancel(idNew) // endedAt = 5000
    const merged = JSON.stringify({
      v: 1,
      handles: [
        ...(JSON.parse(srcOld.serialize()) as { handles: unknown[] }).handles,
        ...(JSON.parse(srcNew.serialize()) as { handles: unknown[] }).handles,
      ],
    })
    // Hydrate at t=6000 with maxAgeMs=2000 → cutoff = 4000.
    // - idOld endedAt=0 < 4000 → DROPPED
    // - idNew endedAt=5000 >= 4000 → KEPT
    const { runner: r3 } = controlledRunner()
    const fresh = defaultBackgroundSubagentScheduler({
      runner: r3,
      hydrateFrom: merged,
      hydrateMaxAgeMs: 2000,
      now: () => 6000,
    })
    expect(fresh.list()).toHaveLength(1)
    expect(fresh.poll(idOld)).toBeNull()
    expect(fresh.poll(idNew)?.status).toBe("cancelled")
  })
})

// ─────────────────────────────────────────────────────────────
// D. snapshotToFile / restoreFromFile (2)
// ─────────────────────────────────────────────────────────────

describe("Subagent persistence — D. disk-backed helpers", () => {
  test("HELL-P11: snapshotToFile writes serialize() output verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-subagent-persist-"))
    const path = join(dir, "subagents.json")
    const { runner, slots } = multiSlotRunner()
    const src = defaultBackgroundSubagentScheduler({ runner, maxConcurrent: 5 })
    src.fork({ task: "to-disk" })
    slots[0]?.({ ok: true, finalText: "disk-done", turns: 1 })
    await yieldMicrotasks()
    await snapshotToFile(src, path)
    const onDisk = await readFile(path, "utf8")
    expect(onDisk).toBe(src.serialize())
    // Sanity: it parses as valid serialized scheduler.
    const parsed = JSON.parse(onDisk) as { v: number; handles: unknown[] }
    expect(parsed.v).toBe(1)
    expect(parsed.handles).toHaveLength(1)
    // Cleanup.
    await unlink(path)
  })

  test("HELL-P12: restoreFromFile with non-existent path → returns null (graceful)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-subagent-persist-"))
    const missing = join(dir, "does-not-exist.json")
    const fresh = freshScheduler()
    const json = await readSnapshotFile(missing)
    expect(json).toBeNull()
    const result = await restoreFromFile(json, fresh)
    expect(result).toBeNull()
    expect(fresh.list()).toHaveLength(0)
  })
})
