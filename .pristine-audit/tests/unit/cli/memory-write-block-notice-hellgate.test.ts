/**
 * WS-G item 4 (UUX-5-11) — memory write-guard blocks were invisible to the
 * OPERATOR: the typed `ok:false` result surfaces to the MODEL only (and the
 * `onArm` telemetry goes to slog.debug). Fix: `writeBlockReason` also emits
 * one LATCHED warn on the operator-notice bus (first block per memoryTools
 * instance — a model retry-looping on a blocked write must not spam).
 *
 * Red-on-injection: read-only mode + memory_write ⇒ ok:false (unchanged) +
 * exactly one notice across two consecutive blocked writes. Paired control:
 * enabled mode ⇒ writes succeed, zero notices.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { memoryTools } from "@/agent/memory-tools"
import type { MemoryEntry, MemoryQuery, PersistentStorePort } from "@/memory"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

const ctx: ToolContext = { cwd: "/tmp", signal: new AbortController().signal }

const run = async (tool: Tool, input: unknown): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input, ctx)) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

const byName = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

class NullStore implements PersistentStorePort {
  save(_e: MemoryEntry): Promise<void> {
    return Promise.resolve()
  }
  update(): Promise<void> {
    return Promise.resolve()
  }
  delete(): Promise<void> {
    return Promise.resolve()
  }
  get(): Promise<MemoryEntry | undefined> {
    return Promise.resolve(undefined)
  }
  all(): Promise<MemoryEntry[]> {
    return Promise.resolve([])
  }
  recall(_q: MemoryQuery): Promise<MemoryEntry[]> {
    return Promise.resolve([])
  }
}

const notices: OperatorNotice[] = []

afterEach(() => {
  __resetOperatorNoticeSinkForTest()
  notices.length = 0
})

describe("memory write-guard block notice (UUX-5-11)", () => {
  test("blocked write ⇒ ok:false kept + ONE latched warn across repeat blocks", async () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const tools = memoryTools({ store: new NullStore(), threadMode: "read-only" })
    const write = byName(tools, "memory_write")
    const first = await run(write, { text: "x" })
    const second = await run(write, { text: "y" })
    if (first.type === "result") expect(first.result.ok).toBe(false)
    if (second.type === "result") expect(second.result.ok).toBe(false)
    const memWarns = notices.filter((n) => n.source === "memory")
    expect(memWarns).toHaveLength(1)
    expect(memWarns[0]?.severity).toBe("warn")
    expect(memWarns[0]?.message).toContain("read-only")
  })

  test("budget-guard block also emits the notice", async () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const tools = memoryTools({
      store: new NullStore(),
      writeGuard: { minRemainingPercent: 50, remainingPercent: () => 10 },
    })
    const write = byName(tools, "memory_write")
    const ev = await run(write, { text: "x" })
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
    expect(notices.filter((n) => n.source === "memory")).toHaveLength(1)
  })

  test("paired control: enabled mode writes succeed with ZERO notices", async () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const tools = memoryTools({ store: new NullStore() })
    const ev = await run(byName(tools, "memory_write"), { text: "x" })
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(notices).toHaveLength(0)
  })
})
