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
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { submitPtyLine, typePtyLine } from "../../tools/dev/pty-slash-submit"
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

const waitForScreenTextAfter = async (
  cli: PtyCli,
  text: string,
  offset: number,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cli.screen().indexOf(text, offset) >= offset) return
    await sleep(25)
  }
  throw new Error(`waitForScreenTextAfter timed out (${timeoutMs}ms) for ${text}`)
}

/** Drive the raw editor as real keystrokes. A whole command in one PTY write can
 * outrun slash-palette state transitions and turn this into a chunking test.
 *
 * The leading `/` used to be guarded by `sleep(500)` — a guess that loses under
 * load, after which the line submits as an ordinary model prompt. The shared
 * helper waits for the slash to REGISTER in the input lane and throws at the
 * drop instead. */
const typeText = async (cli: PtyCli, text: string): Promise<void> => {
  await typePtyLine(cli, text, { keyDelayMs: 20 })
}

const submitLine = async (cli: PtyCli, line: string): Promise<void> => {
  await submitPtyLine(cli, line, { keyDelayMs: 20 })
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
    /** GOAL-04 rail 11 — id-mode argv (`--new-session` / `--resume <id>`) so a
     *  test can restart the PROCESS against the same durable session. */
    readonly argv?: readonly string[]
  }): Promise<PtyCli> => {
    const cassettePath = join(cwd, "goal-continuation.jsonl")
    writeFileSync(cassettePath, args.cassette)
    const c = drivePtyCli({
      ...(cliCommand === undefined ? {} : { command: cliCommand }),
      ...(args.argv === undefined ? {} : { args: args.argv }),
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
    // Use the suite budget for process boot as well. A fixed 15s sub-budget
    // flakes before raw-mode readiness on shared/contended CI hosts even though
    // the enclosing test still has ample time and `waitFor` returns immediately
    // on healthy hosts.
    await c.waitFor(BOOT, T)
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
      // default-ON preset: the wake controller is composed even on a bare goal,
      // and the typed decision says why it will not wake (rail 16).
      await c.waitFor("wake: idle (validation-contract-missing)", T)
    },
    T,
  )

  test(
    "public pause → resume → edit controls mutate the live goal in order",
    async () => {
      const c = await boot()
      await submitLine(c, "/goal ship v1")
      await c.waitFor("Goal created", T)
      await submitLine(c, "/goal criterion add release is verified")
      await c.waitFor("Criterion added.", T)
      await submitLine(c, "/goal pause")
      await c.waitFor("Goal paused.", T)
      await submitLine(c, "/goal")
      await c.waitFor("status: paused", T)
      await submitLine(c, "/goal resume")
      await c.waitFor("Goal resumed.", T)
      await submitLine(c, "/goal edit ship v2")
      await c.waitFor("Goal replaced.", T)
      await submitLine(c, "/goal")
      const screen = await c.waitFor("Goal: ship v2", T)
      expect(screen).toContain("status: active")
    },
    T,
  )

  test(
    "/goal unblock is a reachable operator escape hatch even when there is nothing stale to clear",
    async () => {
      const c = await boot()
      await submitLine(c, "/goal recover blocked work")
      await c.waitFor("Goal created", T)
      await submitLine(c, "/goal unblock")
      const screen = await c.waitFor("Goal: no blocker to clear.", T)
      expect(screen).not.toContain("goal control unavailable")
    },
    T,
  )

  test("public check add → verify → source edit invalidates completion on the next read", async () => {
    writeFileSync(join(cwd, "proof.txt"), "v1\n")
    for (const args of [
      ["init", "-q"],
      ["add", "-A"],
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"],
    ]) {
      const result = Bun.spawnSync(["git", ...args], { cwd })
      expect(result.exitCode).toBe(0)
    }
    const c = await boot()
    await submitLine(c, "/goal prove current source")
    await c.waitFor("Goal created", T)
    await submitLine(c, "/goal check add proof passes -- bun -e process.exit(0)")
    await c.waitFor("Check added.", T)
    await submitLine(c, "/goal verify")
    await c.waitFor("Goal verification applied.", T)
    await submitLine(c, "/goal")
    await c.waitFor("status: completed", T)
    writeFileSync(join(cwd, "proof.txt"), "v2\n")
    await submitLine(c, "/goal")
    const stale = await c.waitFor("freshness: invalidated", T)
    expect(stale).toContain("status: active")
    expect(stale).toContain("0/1 verified")
  }, 120_000)

  test("--max-turns=2 stops autonomous pursuit after two settled attempts", async () => {
    const c = await bootWithGoalContinuation({
      cassette: `${replayEntry("BUDGET_ATTEMPT_ONE")}\n${replayEntry("BUDGET_ATTEMPT_TWO")}\n`,
      idleMs: 15_000,
    })
    await submitLine(c, "/goal bounded pursuit")
    await c.waitFor("Goal created", T)
    await submitLine(c, "/goal criterion add never auto-attested")
    await c.waitFor("Criterion added.", T)
    await submitLine(c, "/goal budget --max-turns=2")
    await c.waitFor("Goal budget updated.", T)
    await c.waitFor("BUDGET_ATTEMPT_ONE", 30_000)
    await c.waitFor("BUDGET_ATTEMPT_TWO", 40_000)
    await c.waitFor("goal: completed · 2 tok", T)
    const settlementOffset = c.screen().lastIndexOf("goal: completed · 2 tok")
    await waitForScreenTextAfter(c, BOOT, settlementOffset, T)
    // The prompt is painted immediately before raw mode is fully active. The
    // compiled binary can reach the settlement footer before that transition;
    // sending `/` in this gap drops only the slash and submits `resume` as a
    // model prompt. Synchronize to the post-settlement prompt, then let the
    // raw-mode transition settle just as the boot helpers do.
    await sleep(50)
    // Two real 15 s quiet windows also trip the REPL's independent idle
    // suppression. Wake that UI gate before exercising the public Goal query.
    await submitLine(c, "/resume")
    await c.waitFor("ready.", T)
    await submitLine(c, "/goal")
    const stopped = await c.waitFor("limited by: user-budget", T)
    expect(stopped).toContain("status: budget_limited")
    expect(stopped).toContain("budget: 2/2 turns")
  }, 120_000)

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
      // GOAL-06 rail 7/15: the 50 ms quiet request is clamped to the public 15 s
      // and armed independently of UI idle suppression — assert the TYPED
      // decision the report renders instead of spending a second real cycle.
      await submitLine(c, "/goal")
      await c.waitFor(/wake: (armed in 15s|pending 15s quiet)/, 10_000)
      await sleep(500)
      expect(c.screen()).not.toContain("GOAL_QUIET_IS_NOT_UI_IDLE")
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
      await sleep(1_000)
      expect(c.screen()).not.toContain("MUST_NOT_ABORT_PARTIAL_DRAFT")
      // Erase the draft (no Enter ever happened) and read the typed decision:
      // raw input cancelled the arm and nothing re-arms before a settled edge.
      for (let i = 0; i < "unfinished operator draft".length; i += 1) c.send("\x7f")
      await sleep(200)
      await submitLine(c, "/goal")
      await c.waitFor(/wake: pending 15s quiet/, 10_000)
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
      // Typed decision: a FULL quiet window was re-armed from the settled edge.
      await submitLine(c, "/goal")
      await c.waitFor(/wake: (armed in 15s|pending 15s quiet)/, 10_000)
      expect(c.screen()).not.toContain("STALE_CONTINUATION_AFTER_FOREGROUND")
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

      await sleep(300)
      expect(c.screen()).not.toContain("BG_GOAL_CONTINUATION_AFTER_SETTLE")
      // Typed decision while the detached body is live: not quiescent.
      await submitLine(c, "/goal")
      await c.waitFor("wake: idle (not-quiescent)", 10_000)
      // The body settles (13 × 150 ms) and a fresh quiet window arms.
      await sleep(2_500)
      await submitLine(c, "/goal")
      await c.waitFor(/wake: (armed in 15s|pending 15s quiet)/, 10_000)
      expect(c.screen()).not.toContain("BG_GOAL_CONTINUATION_AFTER_SETTLE")
    },
    T,
  )

  /** Poll the durable session bytes until `pred` holds (the per-turn save is
   *  asynchronous to the streamed output). Returns false on timeout so the
   *  caller asserts rather than hanging. */
  const waitForDurableGoal = async (
    pred: (raw: string) => boolean,
    timeoutMs = 20_000,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const file = readdirSync(sessionsDir).find((name) => name.endsWith(".json"))
      if (file !== undefined && pred(readFileSync(join(sessionsDir, file), "utf8"))) return true
      await sleep(100)
    }
    return false
  }

  test("GOAL-04 rail 11 — the objective survives a real PROCESS RESTART, and a clear survives it too", async () => {
    // The durable objective snapshot rides the PER-TURN save, so the goal is
    // created AND a turn is run before the process dies (a kill, not a
    // graceful exit: this is the crash-restart shape the rail is about).
    const first = await bootWithGoalContinuation({
      cassette: `${replayEntry("first-run-marker")}\n`,
      idleMs: 15_000,
      argv: ["--new-session"],
    })
    await submitLine(first, "/goal survive the restart")
    await first.waitFor("Goal created", T)
    await submitLine(first, "say something")
    await first.waitFor("first-run-marker", T)
    // The snapshot rides the per-turn SAVE, which lands after the streamed
    // marker — wait for the durable bytes, then kill. (This is the rail: the
    // goal is on disk before any restart, not merely in memory.)
    expect(await waitForDurableGoal((raw) => raw.includes("survive the restart"))).toBe(true)
    first.kill()
    await Promise.race([first.exited, sleep(3_000)])
    cli = undefined

    const ids = readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
    expect(ids).toHaveLength(1)
    const sessionId = ids[0] as string

    // RESTART: a brand-new process reopens the SAME durable session.
    const second = await bootWithGoalContinuation({
      cassette: `${replayEntry("second-run-marker")}\n`,
      idleMs: 15_000,
      argv: ["--resume", sessionId],
    })
    await submitLine(second, "/goal")
    const restored = await second.waitFor("Goal: survive the restart", T)
    expect(restored).toContain("active")

    // ... and a CLEAR is durable across the next restart (GOAL-10 item 7).
    await submitLine(second, "/goal clear")
    await second.waitFor("Goal cleared.", T)
    await submitLine(second, "say something else")
    await second.waitFor("second-run-marker", T)
    expect(await waitForDurableGoal((raw) => !raw.includes("survive the restart"))).toBe(true)
    second.kill()
    await Promise.race([second.exited, sleep(3_000)])
    cli = undefined

    const third = await bootWithGoalContinuation({
      cassette: `${replayEntry("third-run-marker")}\n`,
      idleMs: 15_000,
      argv: ["--resume", sessionId],
    })
    await submitLine(third, "/goal")
    await third.waitFor("No goal set.", T)
    expect(third.screen()).not.toContain("Goal: survive the restart")
  }, 180_000)

  test("attach to thread B cancels thread A's pending continuation before its body can run", async () => {
    const first = await bootWithGoalContinuation({
      cassette: `${replayEntry("A_SAVE")}\n`,
      idleMs: 15_000,
      argv: ["--new-session"],
    })
    await submitLine(first, "/goal thread A must not wake after attach")
    await first.waitFor("Goal created", T)
    await submitLine(first, "/goal criterion add remains unmet")
    await first.waitFor("Criterion added.", T)
    await submitLine(first, "persist A")
    await first.waitFor("A_SAVE", T)
    expect(await waitForDurableGoal((raw) => raw.includes("thread A must not wake"))).toBe(true)
    first.kill()
    await Promise.race([first.exited, sleep(3_000)])
    cli = undefined
    const aId = readdirSync(sessionsDir)
      .find((name) => name.endsWith(".json"))
      ?.slice(0, -5)
    expect(aId).toBeDefined()

    const second = await bootWithGoalContinuation({
      cassette: `${replayEntry("B_SAVE")}\n`,
      idleMs: 15_000,
      argv: ["--new-session"],
    })
    await submitLine(second, "persist B")
    await second.waitFor("B_SAVE", T)
    const countDeadline = Date.now() + 20_000
    while (
      Date.now() < countDeadline &&
      readdirSync(sessionsDir).filter((name) => name.endsWith(".json")).length < 2
    ) {
      await sleep(100)
    }
    second.kill()
    await Promise.race([second.exited, sleep(3_000)])
    cli = undefined
    const bId = readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .find((id) => id !== aId)
    expect(bId).toBeDefined()

    const attached = await bootWithGoalContinuation({
      cassette: `${replayEntry("A_CONTINUATION_MUST_NOT_RUN")}\n`,
      idleMs: 15_000,
      argv: ["--resume", aId as string],
    })
    await submitLine(attached, `/fork attach ${bId as string}`)
    await attached.waitFor(`now editing ${bId as string}`, T)
    await sleep(16_000)
    expect(attached.screen()).not.toContain("A_CONTINUATION_MUST_NOT_RUN")
    await submitLine(attached, "/goal")
    await attached.waitFor("No goal set.", T)
  }, 180_000)

  test("GOAL-05A rail 16 — a settled autonomous turn ANNOUNCES itself without being asked", async () => {
    const c = await bootWithGoalContinuation({
      cassette: `${replayEntry("checkpoint-marker")}\n`,
      idleMs: 15_000,
    })
    await submitLine(c, "/goal ship the checkpoint")
    await c.waitFor("Goal created", T)
    await submitLine(c, "/goal criterion add the marker is printed")
    await c.waitFor("Criterion added.", T)
    // The autonomous continuation fires on its own and settles.
    await c.waitFor("checkpoint-marker", 60_000)
    // ...and the operator learns the outcome WITHOUT typing /goal.
    const screen = await c.waitFor(/goal: (completed|error|max_turns) ·/, 30_000)
    expect(screen).toMatch(/goal: \w+ · \d+ tok · .* · rev \d+ · \d+ receipts/)
    // Text-free: the goal text never rides the checkpoint line.
    const checkpointLine = (screen.match(/goal: \w+ · \d+ tok[^\n]*/) ?? [""])[0]
    expect(checkpointLine).not.toContain("ship the checkpoint")
  }, 180_000)
})
