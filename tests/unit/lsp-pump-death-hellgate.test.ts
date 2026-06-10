/**
 * F-lsp silent-failure hellgate (audit jun-10 finding #9) — LspClient stdout
 * pump death WITHOUT process death must not leave the client half-dead.
 *
 * Before the fix: the pump swallowed its end at debug level and nothing else
 * happened — the server process stayed alive, every pending request burned its
 * full `requestTimeoutMs`, and every FUTURE nav call burned another timeout
 * against a read channel that no longer exists. The sibling `send()` correctly
 * warns on a dead write channel; the read side must mirror it AND propagate
 * the same exit/fail-pending the process-death path (`watchExit`) takes.
 * A clean early EOF (server closed stdout but lives) is the same defect from
 * the caller's point of view as a stream error, so both are covered.
 *
 * Real-effect assertions: a REAL child process (bash) that closes its stdout
 * and keeps living; elapsed bounds prove fail-fast vs the 8s timeout burn.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LspClient, type LspClientSpec } from "@/lsp"
import { logger } from "@/shared"

const SPEC: LspClientSpec = {
  // Closes stdout (clean early EOF) but keeps LIVING for 30s. stderr goes to
  // /dev/null and `exec` replaces bash so no grandchild inherits our pipes —
  // otherwise stop()'s stderr drain would block on the orphan until it exits.
  defaultCommand: ["bash", "-c", "exec 2>/dev/null 1>&-; exec sleep 30"],
  languageIdFor: () => "plaintext",
}

const REQUEST_TIMEOUT_MS = 8_000
/** Fail-fast bound: far under the request timeout the old code burned. */
const FAIL_FAST_BOUND_MS = 4_000

describe("LspClient — stdout pump death while the server process lives (#9)", () => {
  let client: LspClient | null = null
  afterEach(async () => {
    await client?.stop().catch(() => undefined)
    client = null
  })

  test("pending request fails FAST with a transport error (not an 8s timeout burn) and the pump death is WARNED", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      // The child closes its stdout immediately (clean early EOF) but keeps
      // living for 30s — pump death WITHOUT process death.
      client = new LspClient(SPEC, { requestTimeoutMs: REQUEST_TIMEOUT_MS })
      const t0 = Date.now()
      let err: Error | null = null
      try {
        await client.start() // awaits the `initialize` request
      } catch (e) {
        err = e as Error
      }
      const elapsed = Date.now() - t0
      expect(err).not.toBeNull()
      // Fail-fast: the old code waited out the full requestTimeoutMs.
      expect(elapsed).toBeLessThan(FAIL_FAST_BOUND_MS)
      // The rejection names the dead transport, not a timeout.
      expect(String(err)).not.toContain("timed out")
      // Mirror of send(): the pump death is warned, not swallowed at debug.
      const warned = warn.mock.calls.some((c) => String(c[0]).includes("pump"))
      expect(warned).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  test("after pump death every FUTURE call rejects immediately (no per-call timeout burn)", async () => {
    client = new LspClient(SPEC, { requestTimeoutMs: REQUEST_TIMEOUT_MS })
    await client.start().catch(() => undefined)
    // Real file so ensureOpen's read succeeds and the request path is reached.
    const dir = mkdtempSync(join(tmpdir(), "lsp-pump-"))
    const file = join(dir, "x.txt")
    writeFileSync(file, "hello\n")
    const t0 = Date.now()
    let err: Error | null = null
    try {
      await client.definition(file, { line: 0, character: 0 })
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
    expect(String(err)).toContain("stopped/exited") // lifecycle guard, instant
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  test("paired control: a DELIBERATE stop() never logs the pump-death warn", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      // `cat` keeps stdout open and echoes our own requests back (ignored by
      // the dispatcher) — the pump ends only because stop() tears it down.
      client = new LspClient(
        { defaultCommand: ["cat"], languageIdFor: () => "plaintext" },
        { requestTimeoutMs: 300 },
      )
      await client.start().catch(() => undefined) // initialize times out — fine
      await client.stop()
      client = null
      const warned = warn.mock.calls.some((c) => String(c[0]).includes("pump"))
      expect(warned).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})
