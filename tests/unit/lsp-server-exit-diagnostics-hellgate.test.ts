/**
 * LSP server-exit DIAGNOSTICS hellgate (jun-20 finding) — when a language
 * server dies on its own (crash / OOM-kill), the reason MUST be logged.
 *
 * Before the fix: `drainStderr` consumed the server's stderr and DISCARDED every
 * byte (a deadlock guard), and `watchExit` set `exited=true` + failed pending
 * WITHOUT logging the exit code, the signal, or the stderr the server printed on
 * its way out. So a pyright that OOM-died on a large repo (xarray/sklearn,
 * full-remote jun-20) left ZERO diagnosable trace — the operator saw only the
 * downstream symptoms ("failed to write to server stdin", "server stopped/
 * exited") and could not tell crash from OOM from config error.
 *
 * Real-effect assertions use a REAL child process (a fake LSP that never answers
 * `initialize`), since the whole point is the Bun.spawn stderr pipe + exit
 * settlement — a mocked subprocess's event ordering is a free parameter.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { LspClient, type LspClientSpec } from "@/lsp"
import { logger } from "@/shared"

const lang: LspClientSpec["languageIdFor"] = () => "plaintext"

/** Let the async `onExit` handler run: it fails pending, AWAITS the stderr drain
 *  so the tail is complete, then logs. start() rejects at the fail-pending step,
 *  so the log lands a tick later — settle past it. */
const settleExit = () => new Promise((r) => setTimeout(r, 250))

describe("LspClient — server-exit diagnostics (crash/OOM must be logged)", () => {
  let client: LspClient | null = null
  afterEach(async () => {
    await client?.stop().catch(() => undefined)
    client = null
  })

  test("a crashing server logs WARN with its exit code AND the stderr it printed on the way out", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      // Print a recognizable crash reason to STDERR, then exit non-zero of its
      // own accord (never via our stop()). This is the OOM/crash shape.
      client = new LspClient(
        {
          defaultCommand: ["/bin/sh", "-c", "printf 'BOOM_CRASH_REASON xyz\\n' 1>&2; exit 1"],
          languageIdFor: lang,
        },
        { requestTimeoutMs: 500 },
      )
      await client.start().catch(() => undefined) // initialize never answered — fine
      await settleExit()

      const call = warn.mock.calls.find((c) => String(c[0]).includes("exited UNEXPECTEDLY"))
      expect(call).toBeDefined() // formerly: silent — no warn at all
      const detail = call?.[1] as { exitCode: number | null; stderrTail: string }
      expect(detail.exitCode).toBe(1)
      // The death cause that USED to be discarded is now in the log.
      expect(detail.stderrTail).toContain("BOOM_CRASH_REASON")
    } finally {
      warn.mockRestore()
    }
  })

  test("a SIGKILL (the OOM-killer signature) is surfaced as the exit signal", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      // Emulate the kernel OOM-killer: the server is SIGKILLed, not asked to
      // stop. signalCode must reach the log so an operator can spot OOM.
      client = new LspClient(
        { defaultCommand: ["/bin/sh", "-c", "kill -KILL $$"], languageIdFor: lang },
        { requestTimeoutMs: 500 },
      )
      await client.start().catch(() => undefined)
      await settleExit()

      const call = warn.mock.calls.find((c) => String(c[0]).includes("exited UNEXPECTEDLY"))
      expect(call).toBeDefined()
      const detail = call?.[1] as { signal: string | null }
      expect(detail.signal).toBe("SIGKILL")
    } finally {
      warn.mockRestore()
    }
  })

  test("paired control: a DELIBERATE stop() is NOT a crash — no UNEXPECTEDLY warn", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      // `cat` stays alive (stdout open) until WE tear it down. An operator-driven
      // stop must stay quiet (debug), so the warn is specific to real crashes and
      // does not cry wolf on every clean shutdown.
      client = new LspClient({ defaultCommand: ["cat"], languageIdFor: lang }, { requestTimeoutMs: 300 })
      await client.start().catch(() => undefined) // initialize times out — fine
      await client.stop()
      client = null
      await settleExit()

      const cried = warn.mock.calls.some((c) => String(c[0]).includes("exited UNEXPECTEDLY"))
      expect(cried).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})
