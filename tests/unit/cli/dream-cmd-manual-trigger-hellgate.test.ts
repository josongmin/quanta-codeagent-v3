/**
 * ★ HELLGATE — H16 `/dream` MANUAL trigger, REPL-composer ctx-injection closeout.
 *
 * Proves the manual `/dream` slash path is now LIVE: with `ctx.dream.trigger`
 * injected (the surface composer now wires it from
 * `runtimeContext.dreamTrigger()` — see `surface-compose.ts`), invoking
 * `dreamCmd.run([], ctx)`:
 *
 *   (a) RUNS a consolidation now (manual override of the cadence gate — the
 *       trigger's `dream()` bypasses the sessions/hours threshold);
 *   (b) WRITES to the team target (`<root>/team/cross-session.md`), NEVER
 *       MEMORY.md — and the `FileDreamWriteTarget` MEMORY.md refusal STILL holds;
 *   (c) REPORTS a path + a short summary (bytes written + target path);
 *   (d) a THROWING consolidate port ⇒ a clean typed `DreamError` surfaced as a
 *       non-zero exit + an error line, NEVER a crash (no-throw);
 *   (e) REUSES the SAME consolidation core as the auto path — the command drives
 *       the EXACT trigger instance produced by `buildCrossSessionDreamTrigger`
 *       (the host bridge the session-end auto path also fires), so there is no
 *       duplicated consolidate/state/write-target logic.
 *
 * Determinism: injected fixed clock + fake summarizer + fake stage1 store +
 * per-test mkdtemp memory root (cleaned in afterEach). No real LLM / sqlite.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dreamCmd } from "../../../src/apps/cli/dream-cmd"
import type { SlashContext } from "../../../src/apps/cli/slash-commands"
import { InMemoryLock } from "../../../src/auth/lock-in-memory"
import {
  CrossSessionDreamTrigger,
  type DreamConsolidatePort,
  DreamError,
  type DreamWriteTargetPort,
  FileDreamWriteTarget,
  InMemoryDreamState,
  type Phase2Summarizer,
} from "../../../src/memory"
import { buildCrossSessionDreamTrigger } from "../../../src/runner/session-memory-auto"

let root: string | undefined
const newRoot = (): string => {
  root = mkdtempSync(join(tmpdir(), "quanta-dream-cmd-"))
  return root
}
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

const fixedClock = (ms: number) => () => ms

/** Fake stage1 store exposing only `list` (the cross-session injector's read). */
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

/** Build the LIVE trigger the AUTO path builds — this is the SAME factory the
 *  session-end path uses, so the manual `/dream` test exercises the shared
 *  core, not a hand-rolled fake. */
const liveTrigger = (opts: {
  root: string
  summaries?: readonly string[]
  summary?: string
}): CrossSessionDreamTrigger => {
  const t = buildCrossSessionDreamTrigger({
    // sessions=1 so a single manual /dream consolidates deterministically
    env: { QUANTA_AUTO_DREAM: "1", QUANTA_AUTO_DREAM_SESSIONS: "1" },
    memoryRoot: opts.root,
    stage1OutputsStore: fakeStage1Store(opts.summaries ?? []),
    summarizer: fakeSummarizer(opts.summary ?? "## Team knowledge\n- byteCompare"),
    now: fixedClock(1_000_000),
    logWarn: () => undefined,
  })
  if (t === undefined) throw new Error("expected a trigger under QUANTA_AUTO_DREAM=1")
  return t
}

const mkCtx = (
  trigger?: CrossSessionDreamTrigger,
): { cap: { out: string; err: string }; ctx: SlashContext } => {
  const cap = { out: "", err: "" }
  const ctx: SlashContext = {
    out: (s) => {
      cap.out += s
    },
    err: (s) => {
      cap.err += s
    },
    cwd: "/tmp",
    ...(trigger !== undefined ? { dream: { trigger } } : {}),
  }
  return { cap, ctx }
}

describe("H16 — /dream MANUAL trigger (REPL composer ctx injection)", () => {
  test("(a)+(b)+(c) manual /dream runs a consolidation, writes the TEAM target (not MEMORY.md), reports path+summary", async () => {
    const r = newRoot()
    const trigger = liveTrigger({
      root: r,
      summaries: ["- decision: use byteCompare", "- preference: terse replies"],
      summary: "## Team knowledge\n- byteCompare\n- terse",
    })
    const { cap, ctx } = mkCtx(trigger)

    const code = await dreamCmd.run([], ctx)
    expect(code).toBe(0)

    // (a) a consolidation ran → completed report
    expect(cap.out).toContain("done")
    // (c) path + a short summary (bytes + the team target path)
    expect(cap.out).toMatch(/wrote \d+ bytes/)
    expect(cap.out).toContain(join("team", "cross-session.md"))
    // (b) written to the TEAM target, NOT MEMORY.md
    expect(trigger.targetPath.endsWith("MEMORY.md")).toBe(false)
    const team = readFileSync(trigger.targetPath, "utf8")
    expect(team).toContain("Team knowledge")
    // the live MEMORY.md sibling was never created by the dream pass
    expect(() => readFileSync(join(r, "MEMORY.md"), "utf8")).toThrow()
  })

  test("(b) the FileDreamWriteTarget MEMORY.md refusal STILL holds (defense-in-depth)", async () => {
    // A mis-wired target resolving to MEMORY.md must REFUSE — proving the
    // manual path cannot be coerced into clobbering live memory.
    const target = new FileDreamWriteTarget({
      memoryRoot: "/unused",
      fs: {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        rename: async () => undefined,
        unlink: async () => undefined,
      },
    })
    // Force the pathological basename the guard defends against.
    ;(target as unknown as { targetPath: string }).targetPath = "/x/MEMORY.md"
    await expect(target.write("x")).rejects.toThrow(/refuses to write live MEMORY.md/)
  })

  test("(d) a throwing consolidate port ⇒ clean typed DreamError (exit 1 + err line), NEVER a crash", async () => {
    const r = newRoot()
    const throwingConsolidate: DreamConsolidatePort = {
      consolidate: async () => {
        throw new Error("summarizer exploded")
      },
    }
    const writeTarget: DreamWriteTargetPort = new FileDreamWriteTarget({
      memoryRoot: r,
      fs: {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        rename: async () => undefined,
        unlink: async () => undefined,
      },
    })
    const clock = fixedClock(1_000_000)
    // Build a trigger with the SAME shape as the live one but a throwing port,
    // to prove dream-cmd surfaces the error cleanly rather than propagating it.
    const trigger = new CrossSessionDreamTrigger({
      state: new InMemoryDreamState(),
      consolidate: throwingConsolidate,
      writeTarget,
      lock: new InMemoryLock({ now: clock }),
      now: clock,
      policy: { sessionsThreshold: 1, hoursThreshold: 24 },
    })
    const { cap, ctx } = mkCtx(trigger)

    // MUST resolve (no-throw), MUST report failure, MUST NOT crash the surface.
    const code = await dreamCmd.run([], ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("failed")
    expect(cap.err).toContain("summarizer exploded")

    // The outcome carried a typed DreamError out of the core (no-reset contract).
    const outcome = await trigger.dream()
    expect(outcome.kind).toBe("error")
    if (outcome.kind === "error") expect(outcome.error).toBeInstanceOf(DreamError)
  })

  test("(e) REUSES the same core as the auto path — the cmd drives the SAME trigger instance buildCrossSessionDreamTrigger produced", async () => {
    const r = newRoot()
    // The trigger handed to `/dream` is exactly what the AUTO session-end path
    // fires. Calling `dream()` (manual) then `onSessionEnd()` (auto) share ONE
    // state file + ONE write target — no duplicated consolidation logic.
    const trigger = liveTrigger({
      root: r,
      summaries: ["- decision: shared core"],
      summary: "## Team knowledge\n- shared core",
    })
    const { ctx } = mkCtx(trigger)
    const code = await dreamCmd.run([], ctx)
    expect(code).toBe(0)

    // The manual pass reset the persisted cadence counter on the SAME state file
    // the auto path reads — proving one shared state, one shared core.
    const persisted = JSON.parse(readFileSync(join(r, "dream-state.json"), "utf8"))
    expect(persisted.sessionsSinceLastDream).toBe(0)
    expect(persisted.lastOutcome).toBe("completed")
    // And both manual + auto resolve against the SAME single team target file.
    expect(trigger.targetPath).toBe(join(r, "team", "cross-session.md"))
  })

  test("(a') manual /dream OVERRIDES a NOT-due cadence (high threshold, 0 sessions) yet leaves auto state consistent", async () => {
    // Adversarial: the cadence gate is FAR from crossing (threshold 999, 0
    // sessions elapsed, 0 hours). The AUTO path would report below_threshold and
    // NOT fire. The MANUAL /dream MUST still consolidate (true bypass), and MUST
    // reset the persisted counter the auto path subsequently reads — so a manual
    // dream cannot leave the cadence state corrupt for the next session-end.
    const r = newRoot()
    const trigger = buildCrossSessionDreamTrigger({
      env: { QUANTA_AUTO_DREAM: "1", QUANTA_AUTO_DREAM_SESSIONS: "999" },
      memoryRoot: r,
      stage1OutputsStore: fakeStage1Store(["- decision: override the gate"]),
      summarizer: fakeSummarizer("## Team knowledge\n- override"),
      now: fixedClock(1_000_000),
      logWarn: () => undefined,
    })
    if (trigger === undefined) throw new Error("expected a trigger")
    const { cap, ctx } = mkCtx(trigger)

    const code = await dreamCmd.run([], ctx)
    expect(code).toBe(0)
    // Manual fired despite the cadence being nowhere near due.
    expect(cap.out).toContain("done")

    // The persisted state the AUTO path reads next is consistent (counter reset,
    // completed stamp) — NOT corrupted by the out-of-band manual override.
    const persisted = JSON.parse(readFileSync(join(r, "dream-state.json"), "utf8"))
    expect(persisted.sessionsSinceLastDream).toBe(0)
    expect(persisted.lastOutcome).toBe("completed")

    // And the auto path, reading that SAME state, now honestly reports below
    // threshold (1 session since the manual reset, threshold 999) — no double-fire.
    const auto = await trigger.onSessionEnd()
    expect(auto.kind).toBe("below_threshold")
  })

  test("not-wired surface (no ctx.dream) ⇒ inert 'not wired' + exit 2 (D-6, UUX-5-09)", async () => {
    const { cap, ctx } = mkCtx() // no dream slot — the pre-wire production state
    const code = await dreamCmd.run([], ctx)
    expect(code).toBe(2)
    expect(cap.out).toContain("not wired")
    expect(cap.out).toContain("hint: set QUANTA_AUTO_DREAM=1")
  })
})
