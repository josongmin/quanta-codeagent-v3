/**
 * StdioMcpTransport close() SIGTERM→SIGKILL escalation hellgate (jun-10
 * follow-up).
 *
 * Before the fix, `close()` sent SIGTERM and awaited `proc.exited` with NO
 * bound: a server that traps/ignores SIGTERM pinned the await forever, and
 * with it every teardown path that serially stops MCP clients (session close,
 * CLI exit). Real-process pins:
 *
 *   [K1] a child that traps SIGTERM: close() still returns (within the test
 *        grace + margin) and the child is REALLY dead via SIGKILL — red
 *        against the old unbounded await (this test would hang/time out).
 *   [K2] paired control: a SIGTERM-compliant child dies politely — close()
 *        returns well under the grace and SIGKILL is never sent.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"
import type { McpServerConfig } from "@/mcp"
import { StdioMcpTransport, type StdioSpawnFn } from "@/mcp/transports/stdio"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll until the child reports readiness (trap installed) — closing earlier
 *  would race the trap installation and the SIGTERM would land on the default
 *  disposition, vacuously passing the compliant arm. */
const waitForMarker = async (path: string): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("child never reported ready")
    await sleep(10)
  }
}

/** Short test grace so the ignores-SIGTERM arm stays fast; the prod default
 *  (5s) is exercised structurally by the same code path. */
const TEST_GRACE_MS = 200
/** Upper bound for "close() returned promptly" — grace + generous CI margin,
 *  still far under the test runner timeout the OLD unbounded await would hit. */
const CLOSE_BOUND_MS = 3_000

const capturingSpawn = (): { spawn: StdioSpawnFn; procs: Subprocess<"pipe", "pipe", "pipe">[] } => {
  const procs: Subprocess<"pipe", "pipe", "pipe">[] = []
  const spawn: StdioSpawnFn = (command, opts) => {
    const proc = Bun.spawn(command, opts) as Subprocess<"pipe", "pipe", "pipe">
    procs.push(proc)
    return proc
  }
  return { spawn, procs }
}

const cfg = (name: string, script: string): McpServerConfig => ({
  name,
  command: ["bash", "-c", script],
})

describe("StdioMcpTransport.close() — SIGTERM→SIGKILL escalation", () => {
  test("[K1] child trapping SIGTERM: close() returns within the bound and the child dies via SIGKILL", async () => {
    const root = mkdtempSync(join(tmpdir(), "stdio-sigkill-"))
    const marker = join(root, "ready")
    const { spawn, procs } = capturingSpawn()
    // Trap (ignore) SIGTERM, report ready, then spin. Without escalation
    // `proc.exited` never settles and close() hangs — the exact pre-fix defect.
    const transport = new StdioMcpTransport(
      cfg("sigterm-ignorer", `trap '' TERM; : > "${marker}"; while :; do sleep 0.05; done`),
      { spawn, termGraceMs: TEST_GRACE_MS },
    )
    await transport.start()
    const proc = procs[0]
    expect(proc).toBeDefined()
    try {
      await waitForMarker(marker)

      const startedAt = Date.now()
      await transport.close()
      const closeMs = Date.now() - startedAt

      expect(closeMs).toBeLessThan(CLOSE_BOUND_MS)
      // Real effect: the child is dead, and it took the FORCED signal to do it.
      await proc?.exited
      expect(proc?.signalCode).toBe("SIGKILL")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("[K2] paired control: SIGTERM-compliant child dies politely, NO SIGKILL", async () => {
    const { spawn, procs } = capturingSpawn()
    // No trap — default SIGTERM disposition kills the shell loop immediately.
    const transport = new StdioMcpTransport(
      cfg("sigterm-compliant", `while :; do sleep 0.05; done`),
      {
        spawn,
        // LONG grace: if close() returns fast it is because the polite kill
        // worked, not because the escalation fired early.
        termGraceMs: 10_000,
      },
    )
    await transport.start()
    const proc = procs[0]
    expect(proc).toBeDefined()

    const startedAt = Date.now()
    await transport.close()
    const closeMs = Date.now() - startedAt

    expect(closeMs).toBeLessThan(CLOSE_BOUND_MS)
    await proc?.exited
    expect(proc?.signalCode).toBe("SIGTERM")
  })
})
