import { describe, expect, test } from "bun:test"
import { runShell } from "@/runtime"
import type { ShellExecEvent } from "@/tool"

const assertEventOrdering = (events: ShellExecEvent[]): void => {
  expect(events.length).toBeGreaterThanOrEqual(2)
  expect(events[0]?.kind).toBe("start")
  expect(events.at(-1)?.kind).toBe("exit")

  const startEvent = events[0]
  if (startEvent?.kind !== "start") throw new Error("expected start")
  expect(startEvent.pid).toBeGreaterThan(0)
  expect(startEvent.command).toBe("echo hello")
  expect(typeof startEvent.startedAt).toBe("number")

  let stdoutCount = 0
  let stderrCount = 0
  let terminalCount = 0
  for (const [index, event] of events.entries()) {
    if (index === 0) {
      expect(event.kind).toBe("start")
      continue
    }
    if (event.kind === "stdout") stdoutCount++
    else if (event.kind === "stderr") stderrCount++
    else if (event.kind === "exit" || event.kind === "aborted" || event.kind === "detached") {
      terminalCount++
      expect(index).toBe(events.length - 1)
    } else if (event.kind === "start") throw new Error("duplicate start event")
    else {
      const exhaustive: never = event
      throw new Error(`unhandled kind: ${JSON.stringify(exhaustive)}`)
    }
  }
  expect(stdoutCount).toBeGreaterThanOrEqual(1)
  expect(terminalCount).toBe(1)
  expect(stderrCount).toBe(0)
}

const decodeStdout = (events: ShellExecEvent[]): string => {
  const chunks: Uint8Array[] = []
  let expectedOffset = 0
  for (const event of events) {
    if (event.kind !== "stdout") continue
    expect(event.offset).toBe(expectedOffset)
    expectedOffset += event.chunk.byteLength
    chunks.push(event.chunk)
  }
  const concatenated = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    concatenated.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder("utf-8").decode(concatenated)
}

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
    // No event between start and exit may be `start` again or a second terminal.
    assertEventOrdering(events)

    // Concatenated stdout chunks decode to result.stdout byte-for-byte.
    expect(decodeStdout(events)).toBe(r.stdout)
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
