/**
 * Hellgate (U4) — stderr pipe-buffer deadlock guard for the two stdio
 * subprocess carriers (MCP `StdioMcpTransport`, LSP `LspClient`).
 *
 * THE BUG: both spawn a child with `stderr: "pipe"` and historically never
 * read it. A chatty server (MCP debug logs / tsserver / Pyright verbose) fills
 * the ~64KB OS stderr pipe; the child then BLOCKS on its next stderr write and
 * stops answering stdout JSON-RPC, so every pending request hangs to timeout.
 *
 * THE PROOF: we model OS pipe backpressure exactly. The fake child's stderr is
 * a backpressure-gated async iterable that emits >64KB but can only advance
 * when its bytes are consumed; its stdout JSON-RPC answer is GATED behind the
 * stderr producer having drained past the pipe ceiling. So the stdout reply is
 * physically unreachable UNLESS something drains stderr concurrently. With the
 * drain in place, both the >64KB stderr is fully consumed AND the stdout
 * message is received — without it, this test deadlocks (times out).
 *
 * No real subprocess is spawned: the spawn seam / `proc` field is injected.
 */
import { describe, expect, test } from "bun:test"
import { LspClient, type LspClientSpec } from "@/lsp/adapters/base"
import { encodeMessage as encodeLsp } from "@/lsp/adapters/jsonrpc"
import { type McpServerConfig, StdioMcpTransport } from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"

/** ~64KB is the steady-state OS pipe buffer; we drive well past it so an
 *  un-drained pipe is guaranteed to wedge. Not a tuning knob — a generous
 *  ceiling chosen to exceed any real pipe-buffer size. */
const STDERR_TARGET_BYTES = 256 * 1024
const STDERR_CHUNK = new Uint8Array(8 * 1024).fill(0x41) // 'A' * 8KB

/** A backpressure-gated stderr producer: it yields 8KB chunks until it has
 *  emitted >= STDERR_TARGET_BYTES. Each `next()` only resolves when the
 *  consumer pulls — exactly how a full OS pipe blocks the writer. `produced`
 *  tracks bytes the consumer has actually pulled; `pastCeiling` resolves once
 *  the producer has cleared the simulated 64KB ceiling, gating the stdout
 *  reply behind a drained stderr. */
class GatedStderr {
  produced = 0
  private resolveCeiling: () => void = () => {}
  readonly pastCeiling = new Promise<void>((r) => {
    this.resolveCeiling = r
  })

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    while (this.produced < STDERR_TARGET_BYTES) {
      this.produced += STDERR_CHUNK.byteLength
      if (this.produced >= 64 * 1024) this.resolveCeiling()
      yield STDERR_CHUNK
    }
  }
}

describe("U4 — stdio stderr drain prevents pipe-buffer deadlock", () => {
  test("MCP transport: child emitting >64KB to stderr still answers a stdout request", async () => {
    const stderr = new GatedStderr()
    const reply: JsonRpcMessage = { jsonrpc: "2.0", id: 1, result: { ok: true } }
    // stdout yields its JSON-RPC reply only AFTER the stderr producer has
    // cleared the pipe ceiling — i.e. only if stderr is being drained.
    const stdout = (async function* () {
      await stderr.pastCeiling
      yield new TextEncoder().encode(`${JSON.stringify(reply)}\n`)
    })()

    const fakeProc = {
      stdin: { write: () => true },
      stdout,
      stderr,
      exited: new Promise<number>(() => {}),
      kill: () => {},
    }
    const cfg: McpServerConfig = { name: "probe", command: ["/bin/false"] }
    const transport = new StdioMcpTransport(cfg, {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake proc.
      spawn: () => fakeProc as any,
    })

    const received: JsonRpcMessage[] = []
    transport.onMessage((m) => received.push(m))
    await transport.start()

    // Wait for the gated stdout reply. Deadlocks (times out) if stderr undrained.
    const deadline = Date.now() + 5_000
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(received).toEqual([reply])
    // And the full >64KB stderr was actually consumed to completion.
    expect(stderr.produced).toBeGreaterThanOrEqual(STDERR_TARGET_BYTES)
  })

  test("LSP client: server flooding >64KB to stderr does not stall stdout JSON-RPC", async () => {
    const stderr = new GatedStderr()
    // Probe subclass: skip the real spawn + initialize handshake, inject a fake
    // proc with a gated stderr, then exercise the REAL private stdout/stderr
    // pumps (the production wiring) against it.
    class ProbeLsp extends LspClient {
      readonly received: number[] = []
      constructor() {
        const spec: LspClientSpec = {
          defaultCommand: ["unused"],
          languageIdFor: () => "typescript",
        }
        super(spec, { command: ["unused"] })
      }
      installAndPump(proc: unknown): void {
        // 48685efa1 — the stdout/stderr pumps + `proc` were split out of
        // `LspClient` into the `LspTransport` collaborator. The client keeps a
        // `dispatch` method wired into `transport.ports.onMessage`, and delegates
        // `this.proc` to `transport.proc`. So the probe now injects the fake proc
        // and drives the REAL private pumps THROUGH the transport (the drain
        // invariant is unchanged — only its owning object moved).
        const self = this as unknown as {
          transport: {
            proc: unknown
            readPump: Promise<void>
            stderrPump: Promise<void>
            pumpStdout(): Promise<void>
            drainStderr(): Promise<void>
          }
          dispatch(m: unknown): void
        }
        self.transport.proc = proc
        // Capture dispatched responses by id (mirror of production dispatch).
        const origDispatch = self.dispatch.bind(self)
        self.dispatch = (m: unknown) => {
          const r = m as { id?: number }
          if (typeof r.id === "number") this.received.push(r.id)
          origDispatch(m)
        }
        self.transport.readPump = self.transport.pumpStdout()
        self.transport.stderrPump = self.transport.drainStderr()
      }
    }

    const respId = 7
    const stdout = (async function* () {
      await stderr.pastCeiling
      yield encodeLsp({ jsonrpc: "2.0", id: respId, result: null })
    })()

    const fakeProc = {
      stdin: { write: () => true },
      stdout,
      stderr,
      exited: new Promise<number>(() => {}),
      kill: () => {},
    }

    const client = new ProbeLsp()
    client.installAndPump(fakeProc)

    const deadline = Date.now() + 5_000
    while (client.received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(client.received).toContain(respId)
    expect(stderr.produced).toBeGreaterThanOrEqual(STDERR_TARGET_BYTES)
  })
})
