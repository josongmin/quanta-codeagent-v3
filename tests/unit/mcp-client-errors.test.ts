/**
 * MCP client error-path coverage — R-Phase3 P2-4.
 *
 * `mcp/client.ts` throws `McpError` at two specific sites that prior tests
 * only exercised indirectly through the JSON-RPC integration suite:
 *
 *   Line 93  — `start()` rejects empty command array (before any spawn)
 *   Line 163 — `ensureReady()` rejects calls after stop() or before start()
 *
 * Direct isolated coverage matters because (a) these are FAIL-CLOSED guards
 * (a refactor that loosened either would silently allow undefined behaviour
 * in production), and (b) they protect the spawn surface from junk input
 * that the JSON-RPC layer would otherwise discover via a less informative
 * error path.
 *
 * No subprocess is spawned by any test in this file — every assertion is a
 * pure API contract check on the McpClient class.
 */
import { describe, expect, test } from "bun:test"
import { McpClient, McpError, StdioMcpTransport } from "@/mcp"

/** Build a `StdioMcpTransport` whose spawn yields a process with the given
 *  `stdin` (or none). The transport is the post-ADR-0391 seam that owns the
 *  stdin-write path; installing it lets us pin the same fail-closed write
 *  contracts that previously lived inline in `client.ts`. */
const probeStdioTransport = (
  name: string,
  stdin: { write: (chunk: unknown) => unknown } | undefined,
): StdioMcpTransport => {
  const fakeProc = stdin ? { stdin } : {}
  const transport = new StdioMcpTransport(
    { name, command: ["/bin/false"] },
    // biome-ignore lint/suspicious/noExplicitAny: deliberate fake proc for the write-path probe.
    { spawn: () => fakeProc as any },
  )
  // Mark the transport "started" by seeding its private proc (no real spawn).
  ;(transport as unknown as { proc: unknown }).proc = fakeProc
  return transport
}

class TransportProbeMcpClient extends McpClient {
  installTransport(stdin: { write: (chunk: unknown) => unknown } | undefined): void {
    const self = this as unknown as {
      started: boolean
      stopped: boolean
      exited: boolean
      transport: StdioMcpTransport
    }
    self.started = true
    self.stopped = false
    self.exited = false
    self.transport = probeStdioTransport("probe", stdin)
  }

  pendingCount(): number {
    return (this as unknown as { pending: Map<number, unknown> }).pending.size
  }
}

describe("McpClient — empty command rejection (client.ts:93)", () => {
  test("empty command array → start() rejects with McpError, no spawn attempted", async () => {
    const client = new McpClient({ name: "empty-cmd", command: [] })
    await expect(client.start()).rejects.toBeInstanceOf(McpError)
  })

  test("empty command — the rejection carries the server name for triage", async () => {
    const client = new McpClient({ name: "named-empty", command: [] })
    try {
      await client.start()
      // Unreachable: start() must have thrown.
      expect("should-have-thrown").toBe("but-did-not")
    } catch (e) {
      expect(e).toBeInstanceOf(McpError)
      expect((e as Error).message).toContain("named-empty")
      expect((e as Error).message).toContain("empty command")
    }
  })

  test("empty command — start() flips the `started` flag before throwing (so re-start is a no-op)", async () => {
    // The implementation sets `this.started = true` BEFORE the empty-command
    // throw. This is intentional: a second `start()` call should NOT retry the
    // spawn (idempotent start). Pin that contract with a re-call: the second
    // call must resolve cleanly without re-throwing.
    const client = new McpClient({ name: "retry-start", command: [] })
    await expect(client.start()).rejects.toBeInstanceOf(McpError)
    // Second start must be a no-op (`started === true` already).
    await expect(client.start()).resolves.toBeUndefined()
  })
})

describe("McpClient — not-running rejection (client.ts:163)", () => {
  test("listTools() before start() → McpError 'not running'", async () => {
    const client = new McpClient({ name: "never-started", command: ["/bin/false"] })
    await expect(client.listTools()).rejects.toBeInstanceOf(McpError)
    try {
      await client.listTools()
    } catch (e) {
      expect((e as Error).message).toContain("not running")
    }
  })

  test("callTool() before start() → McpError 'not running'", async () => {
    const client = new McpClient({ name: "no-start", command: ["/bin/false"] })
    await expect(client.callTool("alpha", {})).rejects.toBeInstanceOf(McpError)
  })

  test("callTool() after stop() → McpError 'not running'", async () => {
    // We can't actually start the client (would spawn a real subprocess), but
    // calling stop() on a never-started client is idempotent (also tested in
    // mcp-client.test.ts), and the post-stop callTool path is the same
    // ensureReady gate. So a stop()-then-call sequence reaches the same throw.
    const client = new McpClient({ name: "stopped", command: ["/bin/false"] })
    await client.stop() // idempotent on never-started
    await expect(client.callTool("anything", {})).rejects.toBeInstanceOf(McpError)
    await expect(client.listTools()).rejects.toBeInstanceOf(McpError)
  })

  test("stop() on never-started client is a no-op (does not throw)", async () => {
    const client = new McpClient({ name: "noop-stop", command: ["/bin/false"] })
    await expect(client.stop()).resolves.toBeUndefined()
    // Idempotent: a second stop() is also a no-op.
    await expect(client.stop()).resolves.toBeUndefined()
  })
})

describe("McpClient — error class taxonomy", () => {
  test("McpError extends Error (so `instanceof Error` consumers continue to work)", () => {
    const e = new McpError("test")
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(McpError)
    expect(e.message).toBe("test")
  })
})

describe("McpClient — immediate transport failure", () => {
  test("missing stdin rejects immediately and clears the pending slot", async () => {
    const client = new TransportProbeMcpClient({ name: "stdin-missing", command: ["/bin/false"] })
    client.installTransport(undefined)
    const started = Date.now()
    await expect(client.listTools()).rejects.toThrow(/stdin closed/)
    expect(Date.now() - started).toBeLessThan(200)
    expect(client.pendingCount()).toBe(0)
  })

  test("stdin.write throw rejects immediately and clears the pending slot", async () => {
    const client = new TransportProbeMcpClient({ name: "stdin-throw", command: ["/bin/false"] })
    client.installTransport({
      write: () => {
        throw new Error("kaboom")
      },
    })
    const started = Date.now()
    await expect(client.listTools()).rejects.toThrow(/kaboom/)
    expect(Date.now() - started).toBeLessThan(200)
    expect(client.pendingCount()).toBe(0)
  })
})
