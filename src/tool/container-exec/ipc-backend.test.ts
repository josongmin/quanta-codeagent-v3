import { describe, expect, test } from "bun:test"
import { containerExecOverIpc, type JsonLineDuplex } from "./ipc-backend"

/** Controllable in-memory duplex: `write` captures outbound JSON lines; `push` feeds an inbound
 *  line to the bridge's read loop; `end` closes the stream. */
const makeDuplex = () => {
  const written: string[] = []
  const buf: string[] = []
  const resolvers: Array<(v: IteratorResult<string>) => void> = []
  let ended = false
  const push = (line: string): void => {
    const r = resolvers.shift()
    if (r) r({ value: line, done: false })
    else buf.push(line)
  }
  const end = (): void => {
    ended = true
    for (const r of resolvers.splice(0)) r({ value: undefined as never, done: true })
  }
  const lines: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<string>> => {
        const next = buf.shift()
        if (next !== undefined) return Promise.resolve({ value: next, done: false })
        if (ended) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((res) => resolvers.push(res))
      },
    }),
  }
  const duplex: JsonLineDuplex = { write: (l) => written.push(l), lines }
  return { duplex, push, end, written }
}

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>

describe("containerExecOverIpc — JSON-line bridge to the hands process", () => {
  test("sends a framed exec request and resolves the correlated result (code mapped)", async () => {
    const { duplex, push, written } = makeDuplex()
    const port = containerExecOverIpc(duplex)
    const pr = port.exec("ls -la /")
    expect(parse(written[0])).toEqual({ id: 0, type: "exec", command: "ls -la /" })
    push(JSON.stringify({ id: 0, type: "exec_result", stdout: "total 0", stderr: "", code: 0 }))
    expect(await pr).toEqual({ stdout: "total 0", stderr: "", code: 0 })
  })

  test("non-zero exit RESOLVES (the command ran) — never rejects", async () => {
    const { duplex, push } = makeDuplex()
    const port = containerExecOverIpc(duplex)
    const pr = port.exec("false")
    push(JSON.stringify({ id: 0, type: "exec_result", stdout: "", stderr: "nope", code: 1 }))
    expect(await pr).toEqual({ stdout: "", stderr: "nope", code: 1 })
  })

  test("null stdout/stderr (orchestrator None) pass through verbatim", async () => {
    const { duplex, push } = makeDuplex()
    const port = containerExecOverIpc(duplex)
    const pr = port.exec("x")
    push(JSON.stringify({ id: 0, type: "exec_result", stdout: null, stderr: null, code: 0 }))
    expect(await pr).toEqual({ stdout: null, stderr: null, code: 0 })
  })

  test("concurrent calls correlate by id — out-of-order responses resolve the right caller", async () => {
    const { duplex, push, written } = makeDuplex()
    const port = containerExecOverIpc(duplex)
    const a = port.exec("A")
    const b = port.exec("B")
    expect(parse(written[0]).id).toBe(0)
    expect(parse(written[1]).id).toBe(1)
    // respond to B (id 1) FIRST, then A (id 0)
    push(JSON.stringify({ id: 1, type: "exec_result", stdout: "B-out", stderr: "", code: 0 }))
    push(JSON.stringify({ id: 0, type: "exec_result", stdout: "A-out", stderr: "", code: 0 }))
    expect((await a).stdout).toBe("A-out")
    expect((await b).stdout).toBe("B-out")
  })

  test("a transport `error` frame rejects (tool maps to ok:false)", async () => {
    const { duplex, push } = makeDuplex()
    const port = containerExecOverIpc(duplex)
    const pr = port.exec("x")
    push(JSON.stringify({ id: 0, type: "error", message: "env gone" }))
    await expect(pr).rejects.toThrow("env gone")
  })

  test("a malformed inbound line is skipped — does not crash the loop nor settle the wrong call", async () => {
    const { duplex, push } = makeDuplex()
    const port = containerExecOverIpc(duplex)
    const pr = port.exec("x")
    push("not json {{{") // garbage
    push(JSON.stringify({ id: 99, type: "exec_result", stdout: "wrong", stderr: "", code: 0 })) // unknown id
    push(JSON.stringify({ id: 0, type: "exec_result", stdout: "right", stderr: "", code: 0 }))
    expect((await pr).stdout).toBe("right")
  })

  test("abort sends a cancel frame AND still surfaces the hands side's PARTIAL result", async () => {
    const { duplex, push, written } = makeDuplex()
    const port = containerExecOverIpc(duplex)
    const ac = new AbortController()
    const pr = port.exec("sleep 600", ac.signal)
    ac.abort()
    expect(written.some((w) => parse(w).type === "cancel" && parse(w).id === 0)).toBe(true)
    // hands side resolves with what it collected before the kill (SIGKILL=137)
    push(JSON.stringify({ id: 0, type: "exec_result", stdout: "partial", stderr: "", code: 137 }))
    expect(await pr).toEqual({ stdout: "partial", stderr: "", code: 137 })
  })

  test("a closed transport rejects every still-pending call (never hangs forever)", async () => {
    const { duplex, end } = makeDuplex()
    const port = containerExecOverIpc(duplex)
    const pr = port.exec("x")
    end()
    await expect(pr).rejects.toThrow("transport closed")
  })

  test("exec issued AFTER the transport closed rejects synchronously (does NOT hang)", async () => {
    const { duplex, end } = makeDuplex()
    const port = containerExecOverIpc(duplex)
    end() // loop ends + latches closed
    await new Promise((r) => setTimeout(r)) // drain microtasks so the read loop observes the close
    await expect(port.exec("x")).rejects.toThrow("transport closed")
  })

  test("a throwing transport write ⇒ exec rejects (cleanly, via the settle path)", async () => {
    // `lines` never yields/completes → `closed` never latches, so the write path is exercised.
    const throwingDuplex: JsonLineDuplex = {
      write: () => {
        throw new Error("pipe broken")
      },
      lines: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) },
    }
    const port = containerExecOverIpc(throwingDuplex)
    await expect(port.exec("x")).rejects.toThrow("pipe broken")
  })

  test("NO listener leak: after a normal resolve, aborting the signal sends NO cancel", async () => {
    const { duplex, push, written } = makeDuplex()
    const port = containerExecOverIpc(duplex)
    const ac = new AbortController()
    const pr = port.exec("ls", ac.signal)
    push(JSON.stringify({ id: 0, type: "exec_result", stdout: "x", stderr: "", code: 0 }))
    await pr
    const before = written.length
    ac.abort() // the abort listener must have been removed on settle → no new frame
    expect(written.length).toBe(before)
  })
})
