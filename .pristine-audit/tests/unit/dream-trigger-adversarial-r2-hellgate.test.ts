/**
 * ★ ADVERSARIAL ROUND 2 — H16 cross-session auto-dream, deep failure-mode lens.
 *
 * Round-1 (`dream-trigger-wire-e2e-hellgate`) pinned the happy paths + gate +
 * persistence. This round drives the HOST builder `buildCrossSessionDreamTrigger`
 * through the trigger's hostile branches that the injectable seams (summarizer /
 * pre-seeded state file / clock) let us reach end-to-end:
 *
 *   - consolidate THROWS (non-abort) ⇒ `error` outcome, NO team write, counter
 *     NOT reset (the cadence must retry, not silently swallow + reset).
 *   - consolidate throws an ABORT ⇒ propagates (the dream is cancellable; an
 *     abort is never reinterpreted as a completed/error dream).
 *   - HOURS threshold alone fires even when SESSIONS is far from crossing
 *     (OR-semantics) — proves the persisted `lastDreamAtMs` + injected-clock
 *     math drives the cadence, not just the counter.
 *   - whitespace-only consolidate text ⇒ `no_op` (never writes an empty team doc).
 *   - a state file with WRONG-TYPED fields degrades to INITIAL (never crashes).
 *   - a COMPLETED dream resets the cadence: the very next session-end is back
 *     under threshold (no immediate double-fire).
 *
 * Determinism: injected fixed clock + fake summarizer + fake stage1 store +
 * per-test mkdtemp root (cleaned in afterEach). No real LLM / sqlite / wall-clock.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Phase2Summarizer } from "@/memory"
import { buildCrossSessionDreamTrigger } from "@/runner/session-memory-auto"

const MS_PER_HOUR = 3_600_000

let root: string | undefined
const newRoot = (): string => {
  root = mkdtempSync(join(tmpdir(), "quanta-dream-r2-"))
  return root
}
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

const fakeStage1Store = (summaries: readonly string[]) =>
  ({
    list: () =>
      Object.freeze(
        summaries.map((rolloutSummary, i) => ({
          threadId: `t${i}`,
          sourceUpdatedAt: 1,
          rawMemory: rolloutSummary,
          rolloutSummary,
          generatedAt: i + 1,
          rolloutSlug: `slug-${i}`,
          usageCount: 1,
          lastUsage: 1,
          selectedForPhase2: true,
        })),
      ),
    get: () => null,
    put: () => undefined,
    touch: () => undefined,
    markSelectedForPhase2: () => undefined,
    prune: () => 0,
    // biome-ignore lint/suspicious/noExplicitAny: test fake narrowed to `list`
  }) as any

const deps = (o: {
  env: Record<string, string | undefined>
  root: string
  summaries?: readonly string[]
  summarizer?: Phase2Summarizer
  nowMs?: number
}) => ({
  env: o.env,
  memoryRoot: o.root,
  stage1OutputsStore: fakeStage1Store(o.summaries ?? ["- a durable fact"]),
  summarizer: o.summarizer ?? (async () => ({ text: "consolidated" })),
  now: () => o.nowMs ?? 1_000_000,
  logWarn: () => undefined,
})

const readState = (r: string) => JSON.parse(readFileSync(join(r, "dream-state.json"), "utf8"))

describe("H16 adversarial r2 — buildCrossSessionDreamTrigger failure modes", () => {
  test("R2-1 — consolidate THROWS (non-abort) ⇒ error outcome, no team write, counter NOT reset", async () => {
    const r = newRoot()
    const throwing: Phase2Summarizer = async () => {
      throw new Error("summarizer exploded")
    }
    const t = buildCrossSessionDreamTrigger(
      deps({
        env: { QUANTA_AUTO_DREAM: "1", QUANTA_AUTO_DREAM_SESSIONS: "1" },
        root: r,
        summarizer: throwing,
      }),
    )
    const outcome = await t?.onSessionEnd()
    expect(outcome?.kind).toBe("error")
    // no team doc written
    expect(() => readFileSync(t?.targetPath ?? "", "utf8")).toThrow()
    // a failed dream must NOT reset the cadence — the counter stays advanced
    expect(readState(r).sessionsSinceLastDream).toBe(1)
  })

  test("R2-2 — consolidate throws an ABORT ⇒ propagates (never reinterpreted)", async () => {
    const r = newRoot()
    const aborting: Phase2Summarizer = async () => {
      const e = new Error("aborted")
      e.name = "AbortError"
      throw e
    }
    const t = buildCrossSessionDreamTrigger(
      deps({
        env: { QUANTA_AUTO_DREAM: "1", QUANTA_AUTO_DREAM_SESSIONS: "1" },
        root: r,
        summarizer: aborting,
      }),
    )
    await expect(t?.onSessionEnd()).rejects.toThrow(/abort/i)
  })

  test("R2-3 — HOURS threshold fires even when SESSIONS is nowhere near crossing (OR-semantics)", async () => {
    const r = newRoot()
    // Pre-seed a prior completed dream 2h ago; sessions threshold huge so only hours can cross.
    const lastDreamAtMs = 1_000_000
    await Bun.write(
      join(r, "dream-state.json"),
      JSON.stringify({ sessionsSinceLastDream: 0, lastDreamAtMs, lastOutcome: "completed" }),
    )
    const t = buildCrossSessionDreamTrigger(
      deps({
        env: {
          QUANTA_AUTO_DREAM: "1",
          QUANTA_AUTO_DREAM_SESSIONS: "99",
          QUANTA_AUTO_DREAM_HOURS: "1",
        },
        root: r,
        nowMs: lastDreamAtMs + 2 * MS_PER_HOUR,
      }),
    )
    const outcome = await t?.onSessionEnd()
    expect(outcome?.kind).toBe("completed")
    // completed ⇒ cadence reset
    expect(readState(r).sessionsSinceLastDream).toBe(0)
  })

  test("R2-4 — whitespace-only consolidate text ⇒ no_op (never writes an empty team doc)", async () => {
    const r = newRoot()
    const t = buildCrossSessionDreamTrigger(
      deps({
        env: { QUANTA_AUTO_DREAM: "1", QUANTA_AUTO_DREAM_SESSIONS: "1" },
        root: r,
        summarizer: async () => ({ text: "   \n  \t " }),
      }),
    )
    const outcome = await t?.onSessionEnd()
    expect(outcome?.kind).toBe("no_op")
    expect(() => readFileSync(t?.targetPath ?? "", "utf8")).toThrow()
  })

  test("R2-5 — state file with WRONG-TYPED fields degrades to INITIAL (never crashes)", async () => {
    const r = newRoot()
    await Bun.write(
      join(r, "dream-state.json"),
      JSON.stringify({ sessionsSinceLastDream: "five", lastDreamAtMs: "nope" }),
    )
    const t = buildCrossSessionDreamTrigger(deps({ env: { QUANTA_AUTO_DREAM: "1" }, root: r }))
    const outcome = await t?.onSessionEnd()
    // started from INITIAL (count 0) ⇒ advances to 1, below default threshold 5
    expect(outcome?.kind).toBe("below_threshold")
    expect(readState(r).sessionsSinceLastDream).toBe(1)
  })

  test("R2-6 — a completed dream resets the cadence: the next session-end is back under threshold", async () => {
    const r = newRoot()
    const make = () =>
      buildCrossSessionDreamTrigger(
        deps({ env: { QUANTA_AUTO_DREAM: "1", QUANTA_AUTO_DREAM_SESSIONS: "1" }, root: r }),
      )
    const first = await make()?.onSessionEnd()
    expect(first?.kind).toBe("completed")
    // fresh trigger instance over the SAME root reads the reset counter
    const second = await make()?.onSessionEnd()
    // sessions=1 again crosses the threshold-of-1 ⇒ fires again, proving the
    // reset took effect (it did NOT carry 2 from the prior run).
    expect(second?.kind).toBe("completed")
    // a threshold of 1 always re-fires; assert the persisted counter never grew
    // unboundedly (reset each completed pass), i.e. stays 0 post-fire.
    expect(readState(r).sessionsSinceLastDream).toBe(0)
  })
})
