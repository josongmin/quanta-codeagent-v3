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
const INSTALLED_CLI = process.env.QUANTA_E2E_CLI_BIN
const cliCommand =
  INSTALLED_CLI === undefined ? undefined : ([INSTALLED_CLI] as readonly [string, ...string[]])

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

/** Drive the raw editor as real keystrokes. A whole command in one PTY write can
 * outrun slash-palette state transitions and turn this into a chunking test. */
const typeText = async (cli: PtyCli, text: string): Promise<void> => {
  for (const [index, character] of [...text].entries()) {
    cli.send(character)
    // `/` opens the async slash palette; wait for its key handler before typing
    // the filter text, otherwise a large feature set can legitimately drop it.
    await sleep(index === 0 && character === "/" ? 500 : 20)
  }
}

const submitLine = async (cli: PtyCli, line: string): Promise<void> => {
  await typeText(cli, line)
  cli.send("\r")
}

describe.skipIf(!PTY_AVAILABLE)("CLI /goal (Pursuing goal) e2e (PTY)", () => {
  let sessionsDir: string
  let cwd: string
  let cli: PtyCli | undefined

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "e2e-goal-sessions-")) // empty ⇒ no resume picker
    cwd = mkdtempSync(join(tmpdir(), "e2e-goal-cwd-"))
  })
  afterEach(async () => {
    const current = cli
    current?.kill()
    if (current !== undefined) {
      await Promise.race([current.exited, sleep(2_000)])
    }
    cli = undefined
    rmSync(sessionsDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  const boot = async (): Promise<PtyCli> => {
    // The harness passes a whitelisted env, so omitting QUANTA_GOAL here proves
    // the shipped default-ON root rather than inheriting an ambient export.
    const c = drivePtyCli({
      ...(cliCommand === undefined ? {} : { command: cliCommand }),
      cwd,
      env: {
        QUANTA_SESSIONS_DIR: sessionsDir,
      },
    })
    cli = c
    await c.waitFor(BOOT, T)
    // The prompt is painted immediately before raw-mode input is fully ready.
    // Let that transition settle so a fast next test cannot lose its first CR.
    await sleep(50)
    return c
  }

  /** Boot the actual interactive CLI with a deterministic LLM and an explicit
   * production quiet-window configuration. */
  const bootWithGoalContinuation = async (args: {
    readonly cassette: string
    readonly idleMs: number
    readonly replayDelayMs?: number
    /** Explicitly exercise the shipped opt-out path with the same replay
     * harness; absence must leave the continuation queue untouched. */
    readonly goalEnforce?: boolean
    readonly idleSuppress?: boolean
    readonly backgroundTurn?: boolean
  }): Promise<PtyCli> => {
    const cassettePath = join(cwd, "goal-continuation.jsonl")
    writeFileSync(cassettePath, args.cassette)
    const c = drivePtyCli({
      ...(cliCommand === undefined ? {} : { command: cliCommand }),
      cwd,
      env: {
        QUANTA_SESSIONS_DIR: sessionsDir,
        ...(args.goalEnforce === false ? { QUANTA_GOAL: "0" } : {}),
        QUANTA_IDLE_MS: String(args.idleMs),
        QUANTA_GOAL_QUIET_MS: String(args.idleMs),
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
    await sleep(50)
    return c
  }

  test(
    "/help lists /goal — the command is registered at the surface",
    async () => {
      const c = await boot()
      expect(c.screen()).not.toContain("/goal")
      await submitLine(c, "/help")
      await c.waitFor("/goal", T)
      expect(c.screen()).toContain("/goal")
    },
    T,
  )

  test(
    "/goal <objective> records an active pursuing goal in the live CLI",
    async () => {
      const c = await boot()
      await submitLine(c, "/goal ship the pursuit feature")
      // The surface minted the store and populated ctx.goal ⇒ the command sets
      // it (NOT the "not wired" degrade path).
      const screen = await c.waitFor(/Goal created|goal control unavailable/, 10_000)
      expect(screen).toContain("Goal created")
      expect(screen).not.toContain("goal control unavailable")
    },
    T,
  )

  test(
    "the goal persists in the surface store — /goal echoes it back as active",
    async () => {
      const c = await boot()
      await submitLine(c, "/goal measure twice cut once")
      await c.waitFor("Goal created", T)
      await submitLine(c, "/goal")
      await c.waitFor("Goal: measure twice cut once", T)
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
      // A single marker is intentional: the PTY projection must preserve a
      // printable byte immediately following DEC cursor restore. The old ANSI
      // regex consumed `ESC8G` and forced this test to duplicate the marker.
      const c = await bootWithGoalContinuation({
        // Split the leading byte from the tail to mirror real provider
        // streaming, where the first content delta can be one character.
        cassette: `${replayEntry("G", [
          { type: "text_delta", delta: "OAL_AUTONOMOUS_CONTINUATION" },
        ])}\n`,
        idleMs: 15_000,
        replayDelayMs: 100,
      })
      await submitLine(c, "/goal continue through the real REPL queue")
      await c.waitFor("Goal created", T)
      // GOAL-06 rail 16 — a goal without a stopping contract never wakes autonomously.
      await submitLine(c, "/goal criterion add the replay marker is printed")
      await c.waitFor("Criterion added.", T)
      await c.waitFor("GOAL_AUTONOMOUS_CONTINUATION", 20_000)
      expect(c.screen()).toContain("GOAL_AUTONOMOUS_CONTINUATION")
    },
    T,
  )

  test(
    "QUANTA_GOAL=0 explicitly unregisters /goal and leaves the continuation queue untouched",
    async () => {
      const c = await bootWithGoalContinuation({
        cassette: `${replayEntry("MUST_NOT_RUN_WHEN_GOAL_ENFORCE_IS_OFF")}\n`,
        idleMs: 15_000,
        goalEnforce: false,
      })
      c.send("/")
      await sleep(700)
      expect(c.screen()).not.toContain("/goal")
      // This waits across several would-be quiet windows. A source-only gate
      // test cannot establish this: the replay marker is reachable only if the
      // shipped resume sink has pushed through the external prompt queue.
      await sleep(300)
      expect(c.screen()).not.toContain("MUST_NOT_RUN_WHEN_GOAL_ENFORCE_IS_OFF")
    },
    T,
  )

  test(
    "goal continuation uses its own quiet window when UI idle suppression is disabled",
    async () => {
      const c = await bootWithGoalContinuation({
        cassette: `${replayEntry("GOAL_QUIET_IS_NOT_UI_IDLE")}\n`,
        idleMs: 50,
        idleSuppress: false,
      })
      await submitLine(c, "/goal pursue even with UI idle suppression disabled")
      await c.waitFor("Goal created", T)
      // GOAL-06 rail 16 — a goal without a stopping contract never wakes autonomously.
      await submitLine(c, "/goal criterion add the replay marker is printed")
      await c.waitFor("Criterion added.", T)
      await c.waitFor("GOAL_QUIET_IS_NOT_UI_IDLE", 20_000)
      expect(c.screen()).toContain("GOAL_QUIET_IS_NOT_UI_IDLE")
    },
    T,
  )

  test(
    "a partially typed local draft cancels autonomous continuation before Enter",
    async () => {
      const c = await bootWithGoalContinuation({
        cassette: `${replayEntry("MUST_NOT_ABORT_PARTIAL_DRAFT")}\n`,
        idleMs: 15_000,
      })
      await submitLine(c, "/goal preserve an operator draft")
      await c.waitFor(/Goal created[\s\S]*ask before every edit/, 10_000)
      // GOAL-06 rail 16 — a goal without a stopping contract never wakes autonomously.
      await submitLine(c, "/goal criterion add the replay marker is printed")
      await c.waitFor("Criterion added.", T)
      // Deliberately omit Enter. The raw key edge must cancel the goal timer;
      // waiting beyond the full quiet window proves the queued continuation
      // cannot win the prompt race and abort this draft.
      await typeText(c, "unfinished operator draft")
      await sleep(15_500)
      expect(c.screen()).not.toContain("MUST_NOT_ABORT_PARTIAL_DRAFT")
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
      await submitLine(c, "/goal do not overlap a foreground agent turn")
      // Raw mode is restored only after slash dispatch returns to the next
      // prompt. Without this edge, a cooked `\r` can be discarded and turn this
      // into a vacuous autonomous-continuation test.
      await c.waitFor(/Goal created[\s\S]*ask before every edit/, 10_000)
      // GOAL-06 rail 16 — a goal without a stopping contract never wakes autonomously.
      await submitLine(c, "/goal criterion add the replay marker is printed")
      await c.waitFor("Criterion added.", T)
      await submitLine(c, "start the foreground turn")
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

  test(
    "Ctrl+B keeps an active goal continuation blocked until the detached live body settles",
    async () => {
      // The foreground body remains live for roughly two seconds after Ctrl+B.
      // A continuation marker during that interval means the wake guard was tied
      // to the REPL wrapper rather than the shared agent body lifecycle.
      const longForeground = Array.from({ length: 13 }, (_, i) => ({
        type: "text_delta",
        delta: ` background-${i}`,
      }))
      const cassette = `${replayEntry("BG_GOAL_FOREGROUND_STARTED", longForeground)}\n${replayEntry("_BG_GOAL_CONTINUATION_AFTER_SETTLE")}\n`
      const c = await bootWithGoalContinuation({
        cassette,
        // Keep the initial slash-to-foreground interval comfortably below the
        // quiet window; the body then supplies the long blocked interval.
        idleMs: 15_000,
        replayDelayMs: 150,
        backgroundTurn: true,
      })
      await submitLine(c, "/goal wait for detached work to settle")
      await c.waitFor(/Goal created[\s\S]*ask before every edit/, 10_000)
      // GOAL-06 rail 16 — a goal without a stopping contract never wakes autonomously.
      await submitLine(c, "/goal criterion add the replay marker is printed")
      await c.waitFor("Criterion added.", T)
      await submitLine(c, "start a turn that will move to the background")
      // The first replay delta can be painted underneath the terminal spinner,
      // so use a short real body-start interval rather than a fragile rendered
      // text sentinel before sending the raw Ctrl+B byte.
      await sleep(500)
      c.send("\x02")
      await c.waitFor("moved to background", 10_000)

      await sleep(1_000)
      expect(c.screen()).not.toContain("BG_GOAL_CONTINUATION_AFTER_SETTLE")
      await c.waitFor("BG_GOAL_CONTINUATION_AFTER_SETTLE", 22_000)
    },
    T,
  )
})
