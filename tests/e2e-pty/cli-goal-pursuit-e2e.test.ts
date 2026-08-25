/**
 * CLI e2e (PTY) — the "Pursuing goal" (Codex `/goal` parity) feature over a real
 * pseudo-terminal. Boots the ACTUAL CLI from source, so it exercises the whole
 * live stack: boot → surface-compose mints the objective store → dispatch wires
 * `ctx.goal` → the `/goal` slash command → the surface objective store. This is
 * the real end-to-end proof that the feature is WIRED (not "not wired") in the
 * built app — no LLM is called (`/goal` is a slash command, deterministic).
 *
 * The replay cases below also cover autonomous continuation through the shipped
 * path: goal-wake controller -> heartbeat-aware enqueue adapter -> external prompt queue
 * -> real agent turn. They do not use an inline `runAgent` stand-in.
 *
 * Gated on `PTY_AVAILABLE` (visible skip on a Bun build without openpty).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drivePtyCli, PTY_AVAILABLE, type PtyCli } from "./pty-harness"

// Wait for the readline prompt rendered after setRawMode, not the welcome
// banner ("Ctrl+C quit"). Sending `\r` while the PTY is still in cooked mode
// converts it to `\n`, which raw-line-reader intentionally ignores.
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
    // aug-23: `/goal` is gated behind QUANTA_OBJECTIVE_TOOLS as of 8a0dadfd5
    // ("gate CLI + web-daemon objective authority"). The surface builder now
    // leaves the objective store undefined without it, so the command prints
    // its not-wired posture. This suite asserts the WIRED behaviour, so it must
    // opt in — the harness passes a whitelisted env, so an ambient export does
    // not reach the child. NOTE this suite is exactly what caught that
    // regression: the unit hellgates stayed 14/14 green through it.
    const c = drivePtyCli({
      cwd,
      env: { QUANTA_SESSIONS_DIR: sessionsDir, QUANTA_OBJECTIVE_TOOLS: "1" },
    })
    cli = c
    await c.waitFor(BOOT, T)
    return c
  }

  /** Boot the actual interactive CLI with a deterministic LLM and an explicit
   * production quiet-window configuration. */
  const bootWithGoalContinuation = async (args: {
    readonly cassette: string
    readonly idleMs: number
    readonly replayDelayMs?: number
  }): Promise<PtyCli> => {
    const cassettePath = join(cwd, "goal-continuation.jsonl")
    writeFileSync(cassettePath, args.cassette)
    const c = drivePtyCli({
      cwd,
      env: {
        QUANTA_SESSIONS_DIR: sessionsDir,
        QUANTA_OBJECTIVE_TOOLS: "1",
        QUANTA_GOAL_ENFORCE: "1",
        QUANTA_IDLE_MS: String(args.idleMs),
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
      // The surface minted the store and populated ctx.goal ⇒ the command sets
      // it (NOT the "not wired" degrade path).
      const screen = await c.waitFor(/Pursuing goal set|not wired/, T)
      expect(screen).toContain("Pursuing goal set")
      expect(screen).not.toContain("not wired")
    },
    T,
  )

  test(
    "the goal persists in the surface store — /goal echoes it back as active",
    async () => {
      const c = await boot()
      c.send("/goal measure twice cut once\r")
      await c.waitFor("Pursuing goal set", T)
      c.send("/goal\r")
      await c.waitFor("Pursuing goal: measure twice cut once", T)
      expect(c.screen()).toContain("active")
    },
    T,
  )

  test(
    "QUANTA_GOAL_ENFORCE: an idle active goal drives a replayed continuation through the real CLI queue",
    async () => {
      // No user model prompt is submitted in this test. Seeing the marker
      // therefore proves the continuation's own resume sink woke the actual
      // prompt loop, rather than a user keystroke or an inline test stand-in.
      const c = await bootWithGoalContinuation({
        cassette: `${replayEntry("GOAL_AUTONOMOUS_CONTINUATION")}\n`,
        idleMs: 50,
      })
      c.send("/goal continue through the real REPL queue\r")
      await c.waitFor("Pursuing goal set", T)
      await c.waitFor("GOAL_AUTONOMOUS_CONTINUATION", 8_000)
      expect(c.screen()).toContain("GOAL_AUTONOMOUS_CONTINUATION")
    },
    T,
  )

  test(
    "foreground turn re-arms continuation only after a fresh post-settlement quiet window",
    async () => {
      // A local prompt cancels the goal-mutation arm. The foreground prompt is
      // deliberately submitted well inside the 15s quiet window; settlement
      // must then start a NEW full quiet window before continuation can begin.
      const sustainedEvents = Array.from({ length: 9 }, (_, i) => ({
        type: "text_delta",
        delta: ` foreground-${i}`,
      }))
      // The terminal spinner can overwrite the first streamed byte; pad this
      // rendering sentinel so the asserted marker itself is not that byte.
      const cassette = `${replayEntry("_FOREGROUND_TURN_STARTED", [
        ...sustainedEvents,
        { type: "text_delta", delta: " FOREGROUND_TURN_SETTLED" },
      ])}\n${replayEntry("_STALE_CONTINUATION_AFTER_FOREGROUND")}\n`
      const c = await bootWithGoalContinuation({ cassette, idleMs: 15_000, replayDelayMs: 200 })
      c.send("/goal do not overlap a foreground agent turn\r")
      // Raw mode is restored only after slash dispatch returns to the next
      // prompt. Without this edge, a cooked `\r` can be discarded and turn this
      // into a vacuous autonomous-continuation test.
      await c.waitFor(/Pursuing goal set[\s\S]*ask before every edit/, 10_000)
      c.send("start the foreground turn\r")
      await c.waitFor("FOREGROUND_TURN_STARTED", 10_000)
      await c.waitFor("FOREGROUND_TURN_SETTLED", 10_000)

      // RED-on-revert: firing from the settled edge without re-arming the full
      // quiet window makes the marker appear here. This is also stronger than
      // asserting non-concurrent rendering, which cannot observe a stale queue.
      await sleep(500)
      expect(c.screen()).not.toContain("STALE_CONTINUATION_AFTER_FOREGROUND")
      await c.waitFor("STALE_CONTINUATION_AFTER_FOREGROUND", 20_000)
    },
    T,
  )
})
