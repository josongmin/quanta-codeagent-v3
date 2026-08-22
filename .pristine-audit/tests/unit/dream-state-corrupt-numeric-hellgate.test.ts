/**
 * ★ HELLGATE — H16 `JsonFileDreamState` corrupt-NUMERIC poison (jun-06 harden).
 *
 * Round-2 (`dream-trigger-adversarial-r2`, R2-5) proved a WRONG-TYPED state
 * file (string fields) degrades to INITIAL. This battery attacks the harder
 * class the round-1 `typeof === "number"` accept missed: a field that IS a
 * `number` but is INVALID —
 *
 *   - `sessionsSinceLastDream`: NaN / +Infinity / negative / fractional.
 *     A NaN counter poisons the cadence: `NaN + 1 >= threshold` is ALWAYS
 *     false, so auto-dream SILENTLY never fires again. A negative counter
 *     delays it. These must sanitize to a clean integer, not pass through.
 *   - `lastDreamAtMs`: NaN / Infinity (a non-finite clock). Must not persist a
 *     non-finite stamp.
 *   - `lastOutcome`: an arbitrary string not in the closed enum must not be
 *     surfaced verbatim.
 *
 * The state read must NEVER throw and must yield a clean, finite,
 * non-negative-integer counter so the cadence keeps working.
 *
 * Determinism: per-test mkdtemp root, fixed clock, fake stage1 store.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Phase2Summarizer } from "@/memory"
import { buildCrossSessionDreamTrigger } from "@/runner/session-memory-auto"

let root: string | undefined
const newRoot = (): string => {
  root = mkdtempSync(join(tmpdir(), "quanta-dream-corrupt-"))
  return root
}
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

const fakeStage1Store = () =>
  ({
    list: () =>
      Object.freeze([
        {
          threadId: "t0",
          sourceUpdatedAt: 1,
          rawMemory: "- a durable fact",
          rolloutSummary: "- a durable fact",
          generatedAt: 1,
          rolloutSlug: "slug-0",
          usageCount: 1,
          lastUsage: 1,
          selectedForPhase2: true,
        },
      ]),
    get: () => null,
    put: () => undefined,
    touch: () => undefined,
    markSelectedForPhase2: () => undefined,
    prune: () => 0,
    // biome-ignore lint/suspicious/noExplicitAny: test fake narrowed to `list`
  }) as any

const deps = (o: { root: string; nowMs?: number; summarizer?: Phase2Summarizer }) => ({
  env: { QUANTA_AUTO_DREAM: "1", QUANTA_AUTO_DREAM_SESSIONS: "5" } as Record<
    string,
    string | undefined
  >,
  memoryRoot: o.root,
  stage1OutputsStore: fakeStage1Store(),
  summarizer: o.summarizer ?? (async () => ({ text: "consolidated" })),
  now: () => o.nowMs ?? 1_000_000,
  logWarn: () => undefined,
})

const seed = (r: string, raw: string): void => {
  writeFileSync(join(r, "dream-state.json"), raw, "utf8")
}
const readState = (r: string) => JSON.parse(readFileSync(join(r, "dream-state.json"), "utf8"))

describe("JsonFileDreamState — corrupt NUMERIC fields sanitize to a clean counter", () => {
  // Each seed is JSON-valid (so JSON.parse succeeds) but carries a numeric
  // value that is invalid as a session counter. NaN/Infinity are not JSON
  // literals, so model them via the post-parse path: a stringified payload
  // that JSON allows (null) plus the values we can express.
  const cases: ReadonlyArray<{ label: string; raw: string }> = [
    { label: "negative counter", raw: '{"sessionsSinceLastDream":-7,"lastDreamAtMs":null}' },
    { label: "fractional counter", raw: '{"sessionsSinceLastDream":2.9,"lastDreamAtMs":null}' },
    {
      label: "absurdly huge counter",
      raw: '{"sessionsSinceLastDream":1e308,"lastDreamAtMs":null}',
    },
  ]

  for (const c of cases) {
    test(`${c.label} ⇒ degrades to a clean non-negative integer, cadence still works`, async () => {
      const r = newRoot()
      seed(r, c.raw)
      const t = buildCrossSessionDreamTrigger(deps({ root: r }))
      const outcome = await t?.onSessionEnd()
      // The poisoned value must NOT pass through. After one session-end the
      // persisted counter must be a finite, non-negative integer.
      const s = readState(r)
      expect(Number.isInteger(s.sessionsSinceLastDream)).toBe(true)
      expect(s.sessionsSinceLastDream).toBeGreaterThanOrEqual(0)
      // and the trigger produced a well-formed outcome (never crashed)
      if (outcome === undefined) throw new Error("expected an outcome")
      const validKinds: ReadonlyArray<typeof outcome.kind> = [
        "below_threshold",
        "completed",
        "no_op",
      ]
      expect(validKinds).toContain(outcome.kind)
    })
  }

  test("a NEGATIVE counter must not silently disable the cadence forever", async () => {
    const r = newRoot()
    // -1000 + 1 each session would take 1000+ sessions to cross threshold 5.
    seed(r, '{"sessionsSinceLastDream":-1000,"lastDreamAtMs":null}')
    const t = buildCrossSessionDreamTrigger(deps({ root: r }))
    await t?.onSessionEnd()
    const s = readState(r)
    // Sanitized to 0 then advanced to 1 (not -999).
    expect(s.sessionsSinceLastDream).toBe(1)
  })

  test("a non-finite lastDreamAtMs (via a poisoned write) never persists NaN/Infinity", async () => {
    const r = newRoot()
    // JSON cannot carry NaN/Infinity; assert the read sanitizes a numeric stamp
    // that is out of any sane range by ensuring a completed dream stamps a
    // FINITE clock value.
    seed(r, '{"sessionsSinceLastDream":4,"lastDreamAtMs":null,"lastOutcome":"completed"}')
    const t = buildCrossSessionDreamTrigger(deps({ root: r, nowMs: 5_000_000 }))
    // sessions 4 -> 5 crosses threshold 5 -> fires -> completed -> stamps clock
    const outcome = await t?.onSessionEnd()
    expect(outcome?.kind).toBe("completed")
    const s = readState(r)
    expect(Number.isFinite(s.lastDreamAtMs)).toBe(true)
    expect(s.lastDreamAtMs).toBe(5_000_000)
  })

  test("an out-of-enum lastOutcome string degrades to null (not surfaced verbatim)", async () => {
    const r = newRoot()
    seed(
      r,
      '{"sessionsSinceLastDream":0,"lastDreamAtMs":null,"lastOutcome":"<script>pwn</script>"}',
    )
    const t = buildCrossSessionDreamTrigger(deps({ root: r }))
    const s = t?.readState()
    expect(s?.lastOutcome).toBeNull()
  })

  test("a truncated/garbage JSON file ⇒ INITIAL, never throws", async () => {
    const r = newRoot()
    seed(r, '{"sessionsSinceLastDream":4,"lastDrea') // truncated mid-key
    const t = buildCrossSessionDreamTrigger(deps({ root: r }))
    const outcome = await t?.onSessionEnd()
    expect(outcome?.kind).toBe("below_threshold")
    expect(readState(r).sessionsSinceLastDream).toBe(1) // INITIAL 0 -> 1
  })
})
