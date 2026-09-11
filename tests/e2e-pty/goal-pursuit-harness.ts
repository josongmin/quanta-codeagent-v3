/**
 * `tests/e2e-pty/goal-pursuit-harness` — the boot + scenario pieces shared by
 * the `/goal` PR lane and its nightly real-time sibling.
 *
 * # Why it exists
 *
 * `tests/e2e-pty/cli-goal-pursuit-e2e.test.ts` held 22,650 ms of awaited fixed
 * sleeps — MEASURED, and 66% of the entire repository's 34,530 ms — of which a
 * single `await sleep(16_000)` was 16,000. That one wait is not a guess and
 * cannot be replaced by a readiness predicate: the property is that thread A's
 * ALREADY-ARMED continuation does not fire across a full 15-second quiet
 * window, and the CLI surface exposes no observable for "an arm that was
 * cancelled on a session you are no longer attached to". Waiting past the window
 * is the only observation available.
 *
 * So it becomes the one real-time canary, in nightly, and the PR lane keeps the
 * same three-process scenario minus the wait — asserting the typed decision the
 * attached session reports, which IS observable and is what regresses first.
 *
 * The scenario itself lives here rather than being copied into both files.
 * Copying it would put the setup for a rail on two divergent paths, and the
 * first edit to one of them would silently make the other test a different test.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { submitPtyLine, typePtyLine } from "../../tools/dev/pty-slash-submit"
import { drivePtyCli, type PtyCli } from "./pty-harness"

/** The readline prompt painted after `setRawMode`, not the welcome banner. */
export const BOOT = "ask before every edit"
/** Suite budget. Boot on a contended host is the long pole, not any assertion. */
export const T = 60_000

const INSTALLED_CLI = process.env.QUANTA_E2E_CLI_BIN
export const cliCommand =
  INSTALLED_CLI === undefined ? undefined : ([INSTALLED_CLI] as readonly [string, ...string[]])

export const replayEntry = (
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

export const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** Drive the raw editor as real keystrokes. A whole command in one PTY write can
 *  outrun slash-palette state transitions and turn this into a chunking test. */
export const typeText = async (cli: PtyCli, text: string): Promise<void> => {
  await typePtyLine(cli, text, { keyDelayMs: 20 })
}

export const submitLine = async (cli: PtyCli, line: string): Promise<void> => {
  await submitPtyLine(cli, line, { keyDelayMs: 20 })
}

export interface GoalBootArgs {
  readonly cassette: string
  readonly idleMs: number
  readonly replayDelayMs?: number
  readonly goalEnforce?: boolean
  readonly idleSuppress?: boolean
  readonly backgroundTurn?: boolean
  readonly argv?: readonly string[]
}

export interface GoalBooter {
  /** Boot the CLI with a deterministic replay cassette and goal configuration. */
  bootWithGoalContinuation(args: GoalBootArgs): Promise<PtyCli>
  /** Poll the durable session bytes until `pred` holds. False on timeout, so
   *  the caller asserts rather than hanging. */
  waitForDurableGoal(pred: (raw: string) => boolean, timeoutMs?: number): Promise<boolean>
}

export interface GoalBooterPorts {
  readonly cwd: () => string
  readonly sessionsDir: () => string
  /** Record the live CLI so the suite's `afterEach` can kill it. */
  readonly setCli: (cli: PtyCli | undefined) => void
}

export const makeGoalBooter = (ports: GoalBooterPorts): GoalBooter => ({
  async bootWithGoalContinuation(args: GoalBootArgs): Promise<PtyCli> {
    const cassettePath = join(ports.cwd(), "goal-continuation.jsonl")
    writeFileSync(cassettePath, args.cassette)
    const c = drivePtyCli({
      ...(cliCommand === undefined ? {} : { command: cliCommand }),
      ...(args.argv === undefined ? {} : { args: args.argv }),
      cwd: ports.cwd(),
      env: {
        QUANTA_SESSIONS_DIR: ports.sessionsDir(),
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
    ports.setCli(c)
    // The suite budget covers process boot too. A fixed 15 s sub-budget flakes
    // before raw-mode readiness on contended hosts even when the enclosing test
    // has ample time, and `waitFor` returns immediately on healthy ones.
    await c.waitFor(BOOT, T)
    await sleep(50)
    return c
  },

  async waitForDurableGoal(pred, timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const file = readdirSync(ports.sessionsDir()).find((name) => name.endsWith(".json"))
      if (file !== undefined && pred(readFileSync(join(ports.sessionsDir(), file), "utf8")))
        return true
      await sleep(100)
    }
    return false
  },
})

/**
 * The three-process scenario both lanes need: create a goal with an unmet
 * criterion on thread A, persist it, kill A; create thread B, persist it, kill
 * B; then resume A and `/fork attach` B.
 *
 * Returns the attached CLI with A's continuation armed and B in the editor, so
 * the caller can assert either the typed decision (PR) or the real-time
 * non-firing (nightly) against exactly the same setup.
 */
export const attachToSecondThread = async (
  booter: GoalBooter,
  ports: GoalBooterPorts,
  marker: string,
): Promise<PtyCli> => {
  const sessionIds = (): readonly string[] =>
    readdirSync(ports.sessionsDir())
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))

  const first = await booter.bootWithGoalContinuation({
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
  if (!(await booter.waitForDurableGoal((raw) => raw.includes("thread A must not wake"))))
    throw new Error("thread A's goal never reached durable storage")
  first.kill()
  await Promise.race([first.exited, sleep(3_000)])
  ports.setCli(undefined)
  const aId = sessionIds()[0]
  if (aId === undefined) throw new Error("thread A produced no session file")

  const second = await booter.bootWithGoalContinuation({
    cassette: `${replayEntry("B_SAVE")}\n`,
    idleMs: 15_000,
    argv: ["--new-session"],
  })
  await submitLine(second, "persist B")
  await second.waitFor("B_SAVE", T)
  const countDeadline = Date.now() + 20_000
  while (Date.now() < countDeadline && sessionIds().length < 2) await sleep(100)
  second.kill()
  await Promise.race([second.exited, sleep(3_000)])
  ports.setCli(undefined)
  const bId = sessionIds().find((id) => id !== aId)
  if (bId === undefined) throw new Error("thread B produced no distinct session file")

  const attached = await booter.bootWithGoalContinuation({
    cassette: `${replayEntry(marker)}\n`,
    idleMs: 15_000,
    argv: ["--resume", aId],
  })
  await submitLine(attached, `/fork attach ${bId}`)
  await attached.waitFor(`now editing ${bId}`, T)
  return attached
}
