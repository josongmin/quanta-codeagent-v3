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
 * and keeps living; elapsed bounds prove fail-fast vs the 30s timeout burn.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LspClient, type LspClientSpec } from "@/lsp"
import { defaultPpidWalkKiller } from "@/runtime"
import { logger } from "@/shared"

const SPEC: LspClientSpec = {
  // Closes stdout (clean early EOF) but keeps LIVING for 30s. stderr goes to
  // /dev/null and `exec` replaces bash so no grandchild inherits our pipes —
  // otherwise stop()'s stderr drain would block on the orphan until it exits.
  defaultCommand: ["bash", "-c", "exec 2>/dev/null 1>&-; exec sleep 30"],
  languageIdFor: () => "plaintext",
}

// Leave a wide scheduling margin for the real-subprocess test under a loaded
// CI host, while preserving a strict 2× separation from the old timeout-burn
// failure mode. The assertion is about transport failure preceding the RPC
// timeout, not a 4-second host-performance SLA.
const REQUEST_TIMEOUT_MS = 30_000
/** Fail-fast bound: still strictly below the request-timeout burn. */
const FAIL_FAST_BOUND_MS = 15_000

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(25)
  }
  return predicate()
}

describe("LspClient — stdout pump death while the server process lives (#9)", () => {
  let client: LspClient | null = null
  afterEach(async () => {
    await client?.stop().catch(() => undefined)
    client = null
  })

  test("pending request fails FAST with a transport error (not a 30s timeout burn) and the pump death is WARNED", async () => {
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

  // META-LESSON #1 mirror of the MCP suite: any liveness/exit-ordering guard
  // over Bun.spawn needs a REAL subprocess — a fake's event ordering is a free
  // parameter. On a NORMAL shutdown the child closes stdout (settling the pump)
  // a macrotask BEFORE Bun sets `proc.exitCode` / `proc.killed`, so the
  // un-backported zero-yield code judges the child "alive" and misfires the
  // "stdout pump died" warn on EVERY clean exit. The bounded settlement race
  // must absorb that gap.
  test("REAL subprocess: a child that prints then exits 0 emits NO pump-death warn (normal shutdown is quiet)", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      // Print one (ignored) line, then exit 0 of its own accord — NOT via
      // stop(). The stdout EOF reaches our pump before `proc.exited` fans out:
      // the exact race the old zero-yield code lost.
      client = new LspClient(
        {
          defaultCommand: ["/bin/sh", "-c", "printf 'hello\\n'; exit 0"],
          languageIdFor: () => "plaintext",
        },
        { requestTimeoutMs: 300 },
      )
      await client.start().catch(() => undefined) // initialize never answered — fine
      // Let the child fully exit and the pump settle through the grace race.
      await new Promise((r) => setTimeout(r, 200))
      // A clean self-exit is a normal shutdown: the watchExit/process-death
      // path owns it. NO spurious "stdout pump died" warn.
      const warned = warn.mock.calls.some((c) => String(c[0]).includes("pump died"))
      expect(warned).toBe(false)
    } finally {
      warn.mockRestore()
    }
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

  test("REAL subprocess tree: stop() reaps a wrapper child, not just the direct LSP pid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-tree-kill-"))
    const childPidFile = join(dir, "child.pid")
    let childPid: number | null = null
    try {
      client = new LspClient(
        {
          defaultCommand: ["/bin/sh", "-c", `sleep 30 & echo $! > "${childPidFile}"; wait`],
          languageIdFor: () => "plaintext",
        },
        {
          processTreeKiller: defaultPpidWalkKiller(),
          requestTimeoutMs: 200,
        },
      )
      await client.start().catch(() => undefined)
      const wrotePid = await waitUntil(() => existsSync(childPidFile), 1_000)
      expect(wrotePid).toBe(true)
      childPid = Number.parseInt(readFileSync(childPidFile, "utf8").trim(), 10)
      expect(Number.isInteger(childPid)).toBe(true)
      expect(pidIsAlive(childPid)).toBe(true)

      await client.stop()
      client = null

      const childReaped = await waitUntil(() => childPid !== null && !pidIsAlive(childPid), 2_000)
      expect(childReaped).toBe(true)
    } finally {
      if (childPid !== null && pidIsAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL")
        } catch {
          // already gone
        }
      }
    }
  })
})
