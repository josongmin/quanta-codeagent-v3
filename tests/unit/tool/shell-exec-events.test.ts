import { describe, expect, test } from "bun:test"
import { runShell } from "@/runtime"
import type { ShellExecEvent } from "@/tool"

/** PR-5 / ADR-0081 — basic happy path: `echo hello` emits start → stdout(hello\n) → exit(0)
 *  Concatenating the per-chunk bytes reproduces `result.stdout` exactly. */
describe("shell exec events — basic command", () => {
  test("echo hello: start → stdout → exit ordering and byte concatenation", async () => {
    const events: ShellExecEvent[] = []
    const r = await runShell("echo hello", {
      onShellEvent: (e) => events.push(e),
    })

    // Result still matches the buffered shape.
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("hello\n")
    expect(r.stderr).toBe("")
    expect(r.timedOut).toBe(false)

    // Ordering invariants:
    //  - the first event is exactly one `start`
    //  - every `stdout`/`stderr` event precedes the terminal
    //  - the LAST event is `exit` (not `aborted` — no abort/timeout fired)
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events[0]?.kind).toBe("start")
    const last = events[events.length - 1]
    expect(last?.kind).toBe("exit")

    const startEvent = events[0]
    if (startEvent?.kind !== "start") throw new Error("expected start")
    expect(startEvent.pid).toBeGreaterThan(0)
    expect(startEvent.command).toBe("echo hello")
    expect(typeof startEvent.startedAt).toBe("number")

    // No event between start and exit may be `start` again or a second terminal.
    let stdoutCount = 0
    let stderrCount = 0
    let terminalCount = 0
    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      if (!e) continue
      if (i === 0) {
        expect(e.kind).toBe("start")
        continue
      }
      switch (e.kind) {
        case "stdout":
          stdoutCount++
          break
        case "stderr":
          stderrCount++
          break
        case "exit":
        case "aborted":
        case "detached":
          terminalCount++
          // terminal MUST be last
          expect(i).toBe(events.length - 1)
          break
        case "start":
          throw new Error("duplicate start event")
        default: {
          const _exhaustive: never = e
          throw new Error(`unhandled kind: ${JSON.stringify(_exhaustive)}`)
        }
      }
    }
    expect(stdoutCount).toBeGreaterThanOrEqual(1)
    expect(terminalCount).toBe(1)
    expect(stderrCount).toBe(0)

    // Concatenated stdout chunks decode to result.stdout byte-for-byte.
    const stdoutChunks: Uint8Array[] = []
    let expectedOffset = 0
    for (const e of events) {
      if (e.kind === "stdout") {
        expect(e.offset).toBe(expectedOffset)
        expectedOffset += e.chunk.byteLength
        stdoutChunks.push(e.chunk)
      }
    }
    const total = stdoutChunks.reduce((n, c) => n + c.byteLength, 0)
    const concatenated = new Uint8Array(total)
    let off = 0
    for (const c of stdoutChunks) {
      concatenated.set(c, off)
      off += c.byteLength
    }
    const decoded = new TextDecoder("utf-8").decode(concatenated)
    expect(decoded).toBe(r.stdout)
  })

  test("exit event carries the process exit code", async () => {
    const events: ShellExecEvent[] = []
    const r = await runShell("exit 7", { onShellEvent: (e) => events.push(e) })
    expect(r.exitCode).toBe(7)
    const terminal = events[events.length - 1]
    if (terminal?.kind !== "exit") throw new Error("expected exit terminal")
    expect(terminal.code).toBe(7)
  })
})
