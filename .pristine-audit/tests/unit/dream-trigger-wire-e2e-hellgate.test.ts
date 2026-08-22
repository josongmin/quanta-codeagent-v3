/**
 * ★ E2E CONTRACT — H16 cross-session auto-dream, host-binding closeout (§9).
 *
 * Proves the LIVE composition `buildCrossSessionDreamTrigger` (the host bridge in
 * `session-memory-auto.ts`) assembles a REAL `CrossSessionDreamTrigger` over:
 *   - a JSON-FILE state adapter (`<root>/dream-state.json`) — the sessions/hours
 *     cadence PERSISTS across separate trigger instances (= across CLI runs);
 *   - a consolidate adapter that REUSES the cross-session injector + an injected
 *     Phase-2 summarizer (no reimplementation);
 *   - the `team/cross-session.md` write target (NEVER live MEMORY.md);
 *   - a per-process in-memory dream-lock.
 *
 * Gate: `QUANTA_AUTO_DREAM=1` mints the trigger; absent ⇒ undefined (byte-identical
 * default-OFF). The session host fires `onSessionEnd()` once at teardown.
 *
 * Determinism: an injected fixed clock + fake summarizer + fake stage1 store +
 * per-test mkdtemp memory root (cleaned in afterEach). No real LLM, no real
 * sqlite — only the trigger state-machine + the file adapters.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Phase2Summarizer } from "@/memory"
import { buildCrossSessionDreamTrigger } from "@/runner/session-memory-auto"

let root: string | undefined
const newRoot = (): string => {
  root = mkdtempSync(join(tmpdir(), "quanta-dream-"))
  return root
}
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

const fixedClock = (ms: number) => () => ms

/** Fake stage1 store exposing only `list` (the injector's sole read). */
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

const fakeSummarizer =
  (text: string): Phase2Summarizer =>
  async () => ({ text })

const baseDeps = (overrides: {
  env: Record<string, string | undefined>
  root: string
  summaries?: readonly string[]
  summary?: string
  nowMs?: number
}) => ({
  env: overrides.env,
  memoryRoot: overrides.root,
  stage1OutputsStore: fakeStage1Store(overrides.summaries ?? []),
  summarizer: fakeSummarizer(overrides.summary ?? "consolidated team knowledge"),
  now: fixedClock(overrides.nowMs ?? 1_000_000),
  logWarn: () => undefined,
})

describe("H16 — buildCrossSessionDreamTrigger (host-binding closeout)", () => {
  test("A1 — gate OFF (no QUANTA_AUTO_DREAM) ⇒ undefined (byte-identical default)", () => {
    expect(buildCrossSessionDreamTrigger(baseDeps({ env: {}, root: newRoot() }))).toBeUndefined()
  })

  test("A2 — QUANTA_AUTO_DREAM=1 ⇒ enabled trigger over the team target (not MEMORY.md)", () => {
    const t = buildCrossSessionDreamTrigger(
      baseDeps({ env: { QUANTA_AUTO_DREAM: "1" }, root: newRoot() }),
    )
    expect(t).toBeDefined()
    expect(t?.enabled).toBe(true)
    expect(t?.targetPath.endsWith(join("team", "cross-session.md"))).toBe(true)
    expect(t?.targetPath.endsWith("MEMORY.md")).toBe(false)
  })

  test("B1 — below default threshold (1 of 5) ⇒ below_threshold + counter persisted to JSON file", async () => {
    const r = newRoot()
    const t = buildCrossSessionDreamTrigger(baseDeps({ env: { QUANTA_AUTO_DREAM: "1" }, root: r }))
    const outcome = await t?.onSessionEnd()
    expect(outcome?.kind).toBe("below_threshold")
    const persisted = JSON.parse(readFileSync(join(r, "dream-state.json"), "utf8"))
    expect(persisted.sessionsSinceLastDream).toBe(1)
  })

  test("B2 — counter ACCUMULATES across separate trigger instances (cross-run persistence)", async () => {
    const r = newRoot()
    // three independent "CLI runs" over the SAME memory root
    for (let i = 0; i < 3; i++) {
      const t = buildCrossSessionDreamTrigger(
        baseDeps({ env: { QUANTA_AUTO_DREAM: "1" }, root: r }),
      )
      await t?.onSessionEnd()
    }
    const persisted = JSON.parse(readFileSync(join(r, "dream-state.json"), "utf8"))
    expect(persisted.sessionsSinceLastDream).toBe(3)
  })

  test("C1 — threshold crossed (sessions=1) + entries ⇒ consolidated, team file written, counter reset", async () => {
    const r = newRoot()
    const t = buildCrossSessionDreamTrigger(
      baseDeps({
        env: { QUANTA_AUTO_DREAM: "1", QUANTA_AUTO_DREAM_SESSIONS: "1" },
        root: r,
        summaries: ["- decision: use byteCompare", "- preference: terse replies"],
        summary: "## Team knowledge\n- byteCompare\n- terse",
      }),
    )
    const outcome = await t?.onSessionEnd()
    expect(outcome?.kind).toBe("completed")
    const team = readFileSync(t?.targetPath ?? "", "utf8")
    expect(team).toContain("Team knowledge")
    // a completed dream resets the sessions counter
    const persisted = JSON.parse(readFileSync(join(r, "dream-state.json"), "utf8"))
    expect(persisted.sessionsSinceLastDream).toBe(0)
  })

  test("C2 — threshold crossed but NO promoted entries ⇒ no_op (no team write), counter still reset", async () => {
    const r = newRoot()
    const t = buildCrossSessionDreamTrigger(
      baseDeps({
        env: { QUANTA_AUTO_DREAM: "1", QUANTA_AUTO_DREAM_SESSIONS: "1" },
        root: r,
        summaries: [],
      }),
    )
    const outcome = await t?.onSessionEnd()
    expect(outcome?.kind).toBe("no_op")
    // no team file written
    expect(() => readFileSync(t?.targetPath ?? "", "utf8")).toThrow()
    const persisted = JSON.parse(readFileSync(join(r, "dream-state.json"), "utf8"))
    expect(persisted.sessionsSinceLastDream).toBe(0)
  })

  test("D1 — corrupt dream-state.json degrades to initial (never throws)", async () => {
    const r = newRoot()
    await Bun.write(join(r, "dream-state.json"), "{ not json")
    const t = buildCrossSessionDreamTrigger(baseDeps({ env: { QUANTA_AUTO_DREAM: "1" }, root: r }))
    const outcome = await t?.onSessionEnd()
    // started from INITIAL despite corrupt file ⇒ advances to 1, below threshold
    expect(outcome?.kind).toBe("below_threshold")
    if (outcome?.kind === "below_threshold") expect(outcome.sessionsSinceLastDream).toBe(1)
  })
})
