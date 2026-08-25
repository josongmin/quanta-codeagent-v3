/**
 * ★ E2E (PTY) — `/goal` pursuit through the REAL interactive CLI.
 *
 * GOAL-06: the wake controller runs under the PRODUCTION clamp (15 s minimum
 * quiet window; no test-only policy knob). Exactly ONE case performs a real
 * 15 s cycle (the autonomous continuation); every other case asserts the
 * TYPED scheduling decision the `/goal` report renders (`wake: armed in 15s
 * (quiet)` / `wake: idle (…)` / `wake: not composed`) instead of waiting for a
 * fire. Wall-clock budget for the whole file: ≤ 90 s.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drivePtyCli, PTY_AVAILABLE, type PtyCli } from "./pty-harness"

const BOOT = "ask before every edit"
const T = 60_000

const replayEntry = (
  marker: string,
  extraEvents: readonly Record<string, unknown>[] = [],
): string =>
  JSON.stringify({
    id: "replay",
    events: [
      { type: "text_delta", delta: marker },
      ...extraEvents,
      { type: "usage", inputTokens: 1, outputTokens: 1, model: "replay" },
      { type: "message_stop", stop_reason: "end_turn" },
    ],
  })

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

describe.skipIf(!PTY_AVAILABLE)("CLI /goal (Pursuing goal) e2e (PTY)", () => {
  let sessionsDir: string
  let cwd: string
  let cli: PtyCli | undefined

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "e2e-goal-sessions-")) // empty ⇒ no resume picker
    cwd = mkdtempSync(join(tmpdir(), "e2e-goal-cwd-"))
  })

  afterEach(() => {
    cli?.kill()
    cli = undefined
    rmSync(sessionsDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  const boot = async (): Promise<PtyCli> => {
    // `/goal` is gated behind QUANTA_OBJECTIVE_TOOLS (8a0dadfd5); this suite
    // asserts the WIRED behaviour, so it opts in explicitly.
    const c = drivePtyCli({
      cwd,
      env: { QUANTA_SESSIONS_DIR: sessionsDir, QUANTA_OBJECTIVE_TOOLS: "1" },
    })
    cli = c
    await c.waitFor(BOOT, T)
    return c
  }

  /** Boot the actual interactive CLI with a deterministic LLM and the
   *  PRODUCTION quiet-window configuration (a sub-clamp value is clamped). */
  const bootWithGoalContinuation = async (args: {
    readonly cassette: string
    /** UI idle-monitor window (independent of the goal quiet window). */
    readonly idleMs?: number
    readonly quietMs?: number
    readonly replayDelayMs?: number
    readonly goalEnforce?: boolean
    readonly idleSuppress?: boolean
    readonly backgroundTurn?: boolean
  }): Promise<PtyCli> => {
    const cassettePath = join(cwd, "goal-continuation.jsonl")
    writeFileSync(cassettePath, args.cassette)
    const c = drivePtyCli({
      cwd,
      env: {
        QUANTA_SESSIONS_DIR: sessionsDir,
        QUANTA_OBJECTIVE_TOOLS: "1",
        ...(args.goalEnforce === false ? {} : { QUANTA_GOAL_ENFORCE: "1" }),
        QUANTA_IDLE_MS: String(args.idleMs ?? 15_000),
        QUANTA_GOAL_QUIET_MS: String(args.quietMs ?? 15_000),
        ...(args.idleSuppress === false ? { QUANTA_IDLE_SUPPRESS: "0" } : {}),
        ...(args.backgroundTurn === true ? { QUANTA_BG_TURN: "1" } : {}),
        QUANTA_LLM_REPLAY: cassettePath,
        ...(args.replayDelayMs === undefined
          ? {}
          : { QUANTA_LLM_REPLAY_DELAY_MS: String(args.replayDelayMs) }),
        QUANTA_MEMORY: "off",
        QUANTA_MEMORY_AUTO: "0",
        QUANTA_ENABLE_PROMPT_SUGGESTION: "0",
      },
    })
    cli = c
    await c.waitFor(BOOT, 15_000)
    return c
  }

  /** Set a goal WITH a stopping contract (a bare goal is wake-ineligible). */
  const setEligibleGoal = async (c: PtyCli, text: string): Promise<void> => {
    c.send(`/goal ${text}\r`)
    await c.waitFor("Pursuing goal set", T)
    c.send("/goal criterion add the work is done\r")
    await c.waitFor("contract: manual-only", T)
  }

  test(
    "/help lists /goal — the command is registered at the surface",
    async () => {
      const c = await boot()
      c.send("/help\r")
      await c.waitFor("/goal", T)
      expect(c.screen()).toContain("/goal")
    },
    T,
  )

  test(
    "/goal <objective> records an active pursuing goal in the live CLI",
    async () => {
      const c = await boot()
      c.send("/goal ship the pursuit feature\r")
      const screen = await c.waitFor(/Pursuing goal set|not wired/, T)
      expect(screen).toContain("Pursuing goal set")
    },
    T,
  )

  test(
    "the goal persists in the surface store — /goal echoes it back as active with the typed wake line",
    async () => {
      const c = await boot()
      c.send("/goal measure twice cut once\r")
      await c.waitFor("Pursuing goal set", T)
      c.send("/goal\r")
      await c.waitFor("Pursuing goal: measure twice cut once", T)
      // no goal pursuit composed (QUANTA_GOAL_ENFORCE unset) ⇒ typed posture
      expect(c.screen()).toContain("wake: not composed")
    },
    T,
  )

  test(
    "GOAL-06 rail 16 — a bare goal is wake-ineligible: the report says validation-contract-missing and no timer arms",
    async () => {
      const c = await bootWithGoalContinuation({
        cassette: `${replayEntry("MUST_NOT_RUN_WITHOUT_A_CONTRACT")}\n`,
      })
      c.send("/goal a goal without any criterion\r")
      await c.waitFor("Pursuing goal set", T)
      c.send("/goal\r")
      await c.waitFor("wake: idle (validation-contract-missing)", T)
      expect(c.screen()).not.toContain("MUST_NOT_RUN_WITHOUT_A_CONTRACT")
    },
    T,
  )

  test(
    "QUANTA_GOAL_ENFORCE: an idle eligible goal drives ONE replayed continuation through the real CLI queue (the single real 15 s cycle)",
    async () => {
      const c = await bootWithGoalContinuation({
        cassette: `${replayEntry("GOAL_AUTONOMOUS_CONTINUATION")}\n`,
      })
      await setEligibleGoal(c, "continue through the real REPL queue")
      c.send("/goal\r")
      await c.waitFor("wake: armed in 15s (quiet)", T)
      await c.waitFor("GOAL_AUTONOMOUS_CONTINUATION", 30_000)
      expect(c.screen()).toContain("GOAL_AUTONOMOUS_CONTINUATION")
    },
    T,
  )

  test(
    "QUANTA_GOAL_ENFORCE default-OFF leaves the real CLI continuation queue untouched (typed: not composed)",
    async () => {
      const c = await bootWithGoalContinuation({
        cassette: `${replayEntry("MUST_NOT_RUN_WHEN_GOAL_ENFORCE_IS_OFF")}\n`,
        goalEnforce: false,
      })
      await setEligibleGoal(c, "default-off must not autonomously invoke the replay")
      c.send("/goal\r")
      await c.waitFor("wake: not composed", T)
      await sleep(300)
      expect(c.screen()).not.toContain("MUST_NOT_RUN_WHEN_GOAL_ENFORCE_IS_OFF")
    },
    T,
  )

  test(
    "GOAL-06 rail 15 — goal quiet is independent of UI idle suppression: the wake arms under its own window",
    async () => {
      const c = await bootWithGoalContinuation({
        cassette: `${replayEntry("GOAL_QUIET_IS_NOT_UI_IDLE")}\n`,
        idleMs: 50,
        idleSuppress: false,
      })
      await setEligibleGoal(c, "pursue even with UI idle suppression disabled")
      c.send("/goal\r")
      await c.waitFor("wake: armed in 15s (quiet)", T)
    },
    T,
  )

  test(
    "GOAL-06 rail 7 — a sub-clamp QUANTA_GOAL_QUIET_MS is clamped to the public 15 s (typed decision)",
    async () => {
      const c = await bootWithGoalContinuation({
        cassette: `${replayEntry("CLAMPED_QUIET_WINDOW")}\n`,
        quietMs: 50,
      })
      await setEligibleGoal(c, "a fifty millisecond quiet window is clamped")
      c.send("/goal\r")
      await c.waitFor("wake: armed in 15s (quiet)", T)
      // a 50 ms window would have fired long before this
      await sleep(500)
      expect(c.screen()).not.toContain("CLAMPED_QUIET_WINDOW")
    },
    T,
  )

  test(
    "foreground turn re-arms continuation only after a fresh post-settlement quiet window (typed, no second cycle)",
    async () => {
      const sustainedEvents = Array.from({ length: 9 }, (_, i) => ({
        type: "text_delta",
        delta: ` foreground-${i}`,
      }))
      const cassette = `${replayEntry("_FOREGROUND_TURN_STARTED", [
        ...sustainedEvents,
        { type: "text_delta", delta: " FOREGROUND_TURN_SETTLED" },
      ])}\n${replayEntry("_STALE_CONTINUATION_AFTER_FOREGROUND")}\n`
      const c = await bootWithGoalContinuation({ cassette, replayDelayMs: 200 })
      await setEligibleGoal(c, "do not overlap a foreground agent turn")
      c.send("start the foreground turn\r")
      await c.waitFor("FOREGROUND_TURN_STARTED", 10_000)
      await c.waitFor("FOREGROUND_TURN_SETTLED", 10_000)
      await sleep(500)
      expect(c.screen()).not.toContain("STALE_CONTINUATION_AFTER_FOREGROUND")
      c.send("/goal\r")
      await c.waitFor("wake: armed in 15s (quiet)", T)
      expect(c.screen()).not.toContain("STALE_CONTINUATION_AFTER_FOREGROUND")
    },
    T,
  )

  test(
    "Ctrl+B keeps an active goal continuation blocked (typed: background-turn) until the detached live body settles",
    async () => {
      const longForeground = Array.from({ length: 13 }, (_, i) => ({
        type: "text_delta",
        delta: ` background-${i}`,
      }))
      const cassette = `${replayEntry("BG_GOAL_FOREGROUND_STARTED", longForeground)}\n${replayEntry("_BG_GOAL_CONTINUATION_AFTER_SETTLE")}\n`
      const c = await bootWithGoalContinuation({
        cassette,
        replayDelayMs: 150,
        backgroundTurn: true,
      })
      await setEligibleGoal(c, "wait for detached work to settle")
      c.send("start a turn that will move to the background\r")
      await sleep(500)
      c.send("\x02")
      await c.waitFor("moved to background", 10_000)
      c.send("/goal\r")
      await c.waitFor(/wake: idle \(no-longer-quiescent: (background-turn|turn-active)\)/, 10_000)
      expect(c.screen()).not.toContain("BG_GOAL_CONTINUATION_AFTER_SETTLE")
      // the detached body settles (13 × 150 ms) and the next quiet window arms
      await sleep(3_000)
      c.send("/goal\r")
      await c.waitFor("wake: armed in 15s (quiet)", 10_000)
      expect(c.screen()).not.toContain("BG_GOAL_CONTINUATION_AFTER_SETTLE")
    },
    T,
  )
})
