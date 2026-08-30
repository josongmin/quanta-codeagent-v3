/**
 * Usage-accounting process-boundary hellgate.
 *
 * Drives the real interactive CLI through a PTY, persists one priced model
 * call, kills the process, resumes the exact session in a new process, and
 * reads `/cost` before and after another call. This is the product boundary
 * that codec/store unit tests cannot cover: bootstrap hydration, live panel
 * wiring, async turn persistence and rendered slash output all participate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drivePtyCli, PTY_AVAILABLE, type PtyCli, stripAnsi } from "./pty-harness"

const T = 60_000

const replayEntry = (marker: string): string =>
  JSON.stringify({
    id: "replay",
    events: [
      { type: "text_delta", delta: marker },
      {
        type: "usage",
        inputTokens: 1_000_000,
        outputTokens: 0,
        model: "claude-sonnet-4-6",
      },
      { type: "message_stop", stop_reason: "end_turn" },
    ],
  })

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// PTY captures are append-only: an old prompt must never prove that the NEXT
// readLine has attached its keypress listener. Advance this cursor before each
// submit and admit input only after a fresh empty prompt is painted beyond it.
const promptAfter = new WeakMap<PtyCli, number>()
const waitForFrame = async (
  cli: PtyCli,
  after: number,
  accepts: (frame: string) => boolean,
  label: string,
): Promise<void> => {
  const deadline = Date.now() + T
  while (Date.now() < deadline) {
    if (accepts(stripAnsi(cli.output().slice(after)))) return
    await sleep(10)
  }
  throw new Error(`PTY input readiness timed out: ${label}\n${cli.screen().slice(-1500)}`)
}

const submitLine = async (cli: PtyCli, line: string): Promise<void> => {
  // raw-line-reader.ts installs stdin.on("keypress", ...) BEFORE this empty
  // prompt frame. A completed stream or durable save happens earlier and is
  // not a readiness signal; the former driver could lose the leading slash.
  await waitForFrame(cli, promptAfter.get(cli) ?? 0, (frame) => /› \r/.test(frame), "fresh prompt")
  let typed = ""
  for (const character of line) {
    const after = cli.output().length
    cli.send(character)
    typed += character
    const expected = `› ${typed}`
    await waitForFrame(
      cli,
      after,
      (frame) => frame.includes(expected),
      `echo ${JSON.stringify(typed)}`,
    )
  }
  promptAfter.set(cli, cli.output().length)
  cli.send("\r")
}

test("PTY input driver rejects a stale prompt and waits for the next reader frame", async () => {
  let capture = "› \r"
  let typed = ""
  const sent: string[] = []
  const fake: PtyCli = {
    output: () => capture,
    screen: () => capture,
    send: (key) => {
      sent.push(key)
      if (key !== "\r") {
        typed += key
        capture += `› ${typed}\r`
      }
    },
    waitFor: async () => {
      throw new Error("input driver must use a cursor-scoped frame")
    },
    kill: () => undefined,
    exited: Promise.resolve(0),
    cwd: "",
  }
  promptAfter.set(fake, capture.length)
  const pending = submitLine(fake, "/cost")
  await Promise.resolve()
  expect(sent).toEqual([])
  // A turn/save marker is not a raw-reader readiness acknowledgement either.
  capture += "done; durable save completed\r\n"
  await Promise.resolve()
  expect(sent).toEqual([])
  capture += "› \r"
  await pending
  expect(sent).toEqual(["/", "c", "o", "s", "t", "\r"])
})

describe.skipIf(!PTY_AVAILABLE)("CLI usage accounting resume e2e (PTY)", () => {
  let sessionsDir = ""
  let cwd = ""
  let cli: PtyCli | undefined
  let cassetteSeq = 0

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "e2e-cost-sessions-"))
    cwd = mkdtempSync(join(tmpdir(), "e2e-cost-cwd-"))
  })

  afterEach(async () => {
    const current = cli
    current?.kill()
    if (current !== undefined) await Promise.race([current.exited, sleep(2_000)])
    cli = undefined
    rmSync(sessionsDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  const boot = async (
    marker: string,
    args: readonly string[],
    extraEnv: Record<string, string> = {},
  ): Promise<PtyCli> => {
    cassetteSeq += 1
    const cassette = join(cwd, `usage-${cassetteSeq}.jsonl`)
    writeFileSync(cassette, `${replayEntry(marker)}\n`, "utf8")
    const started = drivePtyCli({
      args,
      cwd,
      cols: 160,
      env: {
        QUANTA_SESSIONS_DIR: sessionsDir,
        QUANTA_LLM_REPLAY: cassette,
        QUANTA_GOAL: "0",
        QUANTA_MEMORY: "off",
        QUANTA_MEMORY_AUTO: "0",
        QUANTA_ENABLE_PROMPT_SUGGESTION: "0",
        ...extraEnv,
      },
    })
    cli = started
    return started
  }

  const stop = async (running: PtyCli): Promise<void> => {
    running.kill()
    await Promise.race([running.exited, sleep(3_000)])
    if (cli === running) cli = undefined
  }

  const sessionFile = (): string => {
    const file = readdirSync(sessionsDir).find((name) => name.endsWith(".json"))
    if (file === undefined) throw new Error("session was not persisted")
    return join(sessionsDir, file)
  }

  const waitForBooks = async (minimumCalls = 1): Promise<string> => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const file = readdirSync(sessionsDir).find((name) => name.endsWith(".json"))
      if (file !== undefined) {
        const raw = readFileSync(join(sessionsDir, file), "utf8")
        const saved = JSON.parse(raw) as { usageAccounting?: unknown }
        if (typeof saved.usageAccounting === "string") {
          const books = JSON.parse(saved.usageAccounting) as { total?: { calls?: unknown } }
          if (books.total?.calls === minimumCalls) return join(sessionsDir, file)
        }
      }
      await sleep(100)
    }
    throw new Error("durable usageAccounting snapshot did not appear")
  }

  test("priced totals survive restart, continue after resume, and off/corrupt states stay honest", async () => {
    const first = await boot("first-cost-turn", ["--new-session"])
    await submitLine(first, "spend once")
    await first.waitFor("first-cost-turn", T)
    await waitForBooks()
    await submitLine(first, "/cost")
    await first.waitFor("1,000,000 tok", T)
    expect(first.screen()).toContain("$3.00")
    await stop(first)

    const file = sessionFile()
    const sessionId = file.slice(file.lastIndexOf("/") + 1, -".json".length)
    const second = await boot("second-cost-turn", ["--resume", sessionId])
    await submitLine(second, "/cost")
    await second.waitFor("1,000,000 tok", T)
    expect(second.screen()).toContain("$3.00")
    await submitLine(second, "spend again")
    await second.waitFor("second-cost-turn", T)
    // Persistence and input-readiness are independent barriers: waitForBooks
    // proves the durable admission; submitLine separately awaits reader re-arm.
    await waitForBooks(2)
    await submitLine(second, "/cost")
    await second.waitFor("2,000,000 tok", T)
    expect(second.screen()).toContain("$6.00")
    await stop(second)

    const durable = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    durable.usageAccounting = "{ corrupt"
    writeFileSync(file, JSON.stringify(durable), "utf8")
    const corrupt = await boot("unused-corrupt", ["--resume", sessionId])
    await submitLine(corrupt, "/cost")
    await corrupt.waitFor("prior totals lost", T)
    expect(corrupt.screen()).toContain("totals restart at $0")
    await stop(corrupt)

    const off = await boot("unused-off", ["--new-session"], {
      QUANTA_USAGE_ACCOUNTING_V2: "off",
    })
    await submitLine(off, "/cost")
    await off.waitFor("Accounting:", T)
    expect(off.screen()).toContain("off (QUANTA_USAGE_ACCOUNTING_V2=off)")
  }, 240_000)
})
