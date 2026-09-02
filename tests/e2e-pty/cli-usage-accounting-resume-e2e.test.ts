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
import { submitPtyLine } from "../../tools/dev/pty-slash-submit"
import { drivePtyCli, PTY_AVAILABLE, type PtyCli } from "./pty-harness"

const BOOT = "ask before every edit"
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

/** A dropped leading `/` used to be guarded by `sleep(500)` — a guess that
 *  loses under load and then submits the line as an ordinary model prompt,
 *  burning the one-record cassette and failing 60s later as a ReplayMiss. The
 *  shared helper waits for the slash to REGISTER and throws at the drop. */
const submitLine = async (cli: PtyCli, line: string): Promise<void> => {
  await submitPtyLine(cli, line, { keyDelayMs: 15 })
}

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
    await started.waitFor(BOOT, T)
    await sleep(50)
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
    // The marker is streamed before the async turn-save and prompt re-arm.
    // Waiting for the second durable admission prevents `/` from racing raw
    // input setup and being interpreted as an ordinary model prompt.
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
