/**
 * B4 hellgate — the `terminal` ToolSurface composition root (RFC jun-29 §13, spec S2/S3).
 *
 * Proves the brain-side entry-point ACTUALLY assembles the surface: container_exec + pty_* are
 * minted per the wired ports (and ONLY those — never the BASE repo-edit/host-exec set), the
 * operator capability guide is injected, and `terminalSurfaceOverDuplex` REALLY wires
 * `containerExecOverIpc` (a command round-trips through the JSON-line duplex to a hands-process
 * frame — not a mere reference). Closes the 0-production-caller gap on `buildTerminalTools`,
 * `terminalOperatorGuide`, and `containerExecOverIpc`.
 */
import { describe, expect, test } from "bun:test"
import { TERMINAL_OPERATOR_GUIDE } from "@/tool"
import type { ContainerExec, JsonLineDuplex } from "@/tool/container-exec"
import { createTmuxAdapter } from "@/tool/pty"
import { assembleTerminalSurface, terminalSurfaceOverDuplex } from "./index"

/** In-memory line-duplex (mirrors ipc-backend.test.ts): `write` captures outbound JSON lines,
 *  `push` feeds an inbound line to the bridge read loop, `end` closes the stream. */
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

const fakePty = () => createTmuxAdapter({ exec: { run: async () => ({ ok: true, stdout: "" }) } })
const noopExec: ContainerExec = { exec: async () => ({ stdout: "", stderr: "", code: 0 }) }
const BASE_TOOLS = ["read", "write", "edit", "apply_patch", "bash", "grep", "test_runner", "ls"]

describe("terminal surface composition root (B4)", () => {
  test("both ports wired ⇒ container_exec + pty_* minted, ZERO BASE tools", () => {
    const names = assembleTerminalSurface({
      containerExec: noopExec,
      ptySession: fakePty(),
    }).tools.map((t) => t.name)
    expect(names).toContain("container_exec")
    // exactly the 6 pty_* tools (attach/list/write/read/resize/kill) — a dropped one goes RED here.
    expect(names.filter((n) => n.startsWith("pty_")).length).toBe(6)
    // spec S2/S3: the BASE repo-edit / host-exec set can NEVER leak onto the terminal surface.
    for (const base of BASE_TOOLS) expect(names).not.toContain(base)
  })

  test("no ports ⇒ EMPTY tool set (fail-safe; never falls back to BASE)", () => {
    expect(assembleTerminalSurface({}).tools).toEqual([])
    expect(assembleTerminalSurface().tools).toEqual([])
  })

  test("paired control — each tool family appears IFF its own port is wired", () => {
    const ptyOnly = assembleTerminalSurface({ ptySession: fakePty() }).tools.map((t) => t.name)
    expect(ptyOnly).not.toContain("container_exec")
    expect(ptyOnly.filter((n) => n.startsWith("pty_")).length).toBe(6)

    const execOnly = assembleTerminalSurface({ containerExec: noopExec }).tools.map((t) => t.name)
    expect(execOnly).toContain("container_exec")
    expect(execOnly.filter((n) => n.startsWith("pty_"))).toEqual([])
  })

  test("operatorGuide is the REAL capability guide (injected, non-empty)", () => {
    const surface = assembleTerminalSurface({ containerExec: noopExec })
    expect(surface.operatorGuide).toBe(TERMINAL_OPERATOR_GUIDE)
    expect(surface.operatorGuide.length).toBeGreaterThan(0)
  })

  test("terminalSurfaceOverDuplex: container_exec ROUND-TRIPS a command through the duplex", async () => {
    const { duplex, push, written } = makeDuplex()
    const tool = terminalSurfaceOverDuplex(duplex, fakePty()).tools.find(
      (t) => t.name === "container_exec",
    )
    if (!tool) throw new Error("container_exec must be minted on the duplex-backed surface")
    // Only `signal` is read by container_exec's execute (verified in container-exec/tool.ts).
    const ctx = { signal: new AbortController().signal } as unknown as Parameters<
      typeof tool.execute
    >[1]
    const it = tool.execute({ command: "echo hi" }, ctx)[Symbol.asyncIterator]()
    const nextP = it.next() // starts execute → port.exec writes the framed request, then awaits
    await new Promise((r) => setTimeout(r, 0))
    // The brain framed a real exec request onto the wire (proves containerExecOverIpc is wired).
    const frame = written[0]
    expect(frame).toBeDefined()
    expect(JSON.parse(frame ?? "")).toMatchObject({ id: 0, type: "exec", command: "echo hi" })
    // The hands process replies with the container's result…
    push(JSON.stringify({ id: 0, type: "exec_result", stdout: "hi", stderr: "", code: 0 }))
    const { value } = await nextP
    // Runtime shape verified in container-exec/tool.ts: execute yields `{ type:"result", result }`.
    const ev = value as { type: string; result: { ok: boolean; output: string } }
    expect(ev.type).toBe("result")
    expect(ev.result.ok).toBe(true)
    expect(ev.result.output).toContain("exit: 0")
    expect(ev.result.output).toContain("hi")
  })

  test("terminalSurfaceOverDuplex without a pty backend ⇒ container_exec only", () => {
    const { duplex } = makeDuplex()
    const names = terminalSurfaceOverDuplex(duplex).tools.map((t) => t.name)
    expect(names).toEqual(["container_exec"])
  })
})
