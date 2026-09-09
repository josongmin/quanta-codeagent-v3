import { describe, expect, test } from "bun:test"
import type { HookPromptInject } from "@/agent/hooks"
import { HookBus } from "@/agent/hooks"
import { attachLspDiagnosticsHook } from "@/agent/lsp-diagnostics-hook"
import type { DiagnosticItem, DiagnosticsSession } from "@/tool"

const errDiag = (message: string): DiagnosticItem => ({
  severity: "error",
  message,
  range: { start: { line: 1, character: 0 } },
})

const session = (diags: DiagnosticItem[]): DiagnosticsSession & { stopped: number } => {
  const s = {
    stopped: 0,
    diagnostics: async () => diags,
    stop: async () => {
      s.stopped += 1
    },
  }
  return s
}

const EDIT = new Map<string, (input: unknown) => string | null>([
  ["edit", (i) => (i as { path?: string }).path ?? null],
])

const emitEdit = (bus: HookBus, path = "/work/a.ts") =>
  bus.emit({
    type: "post_tool_use",
    name: "edit",
    input: { path },
    ok: true,
    output: "edited",
  })

describe("P2-A-05 diagnostics open cache eviction", () => {
  test("null then live reopens and injects", async () => {
    const bus = new HookBus()
    const pushed: HookPromptInject[] = []
    let n = 0
    const live = session([errDiag("boom")])
    attachLspDiagnosticsHook({
      hooks: bus,
      push: { push: (e) => pushed.push(e) },
      editTools: EDIT,
      open: async () => {
        n += 1
        return n === 1 ? null : live
      },
      cwd: "/work",
    })
    await emitEdit(bus)
    expect(pushed).toHaveLength(0)
    await emitEdit(bus)
    expect(n).toBe(2)
    expect(pushed).toHaveLength(1)
  })

  test("rejection then live reopens", async () => {
    const bus = new HookBus()
    const pushed: HookPromptInject[] = []
    let n = 0
    const live = session([errDiag("late")])
    attachLspDiagnosticsHook({
      hooks: bus,
      push: { push: (e) => pushed.push(e) },
      editTools: EDIT,
      open: async () => {
        n += 1
        if (n === 1) throw new Error("handshake failed")
        return live
      },
      cwd: "/work",
    })
    await emitEdit(bus)
    await emitEdit(bus)
    expect(n).toBe(2)
    expect(pushed).toHaveLength(1)
  })

  test("concurrent opens share one in-flight promise", async () => {
    const bus = new HookBus()
    let n = 0
    let release!: (s: DiagnosticsSession) => void
    const live = session([errDiag("x")])
    attachLspDiagnosticsHook({
      hooks: bus,
      push: { push: () => {} },
      editTools: EDIT,
      open: () => {
        n += 1
        return new Promise((resolve) => {
          release = resolve
        })
      },
      cwd: "/work",
    })
    const a = emitEdit(bus)
    const b = emitEdit(bus)
    await Bun.sleep(10)
    expect(n).toBe(1)
    release(live)
    await Promise.all([a, b])
    expect(n).toBe(1)
  })

  test("late failure does not evict a newer successful client", async () => {
    const bus = new HookBus()
    const pushed: HookPromptInject[] = []
    let n = 0
    let finishFirst!: (v: DiagnosticsSession | null) => void
    const live = session([errDiag("ok")])
    attachLspDiagnosticsHook({
      hooks: bus,
      push: { push: (e) => pushed.push(e) },
      editTools: EDIT,
      open: () => {
        n += 1
        if (n === 1) {
          return new Promise<DiagnosticsSession | null>((resolve) => {
            finishFirst = resolve
          })
        }
        return Promise.resolve(live)
      },
      cwd: "/work",
    })
    const first = emitEdit(bus)
    await Bun.sleep(5)
    finishFirst(null)
    await first
    await emitEdit(bus)
    expect(n).toBe(2)
    expect(pushed).toHaveLength(1)
    finishFirst(null)
    await emitEdit(bus)
    expect(n).toBe(2)
  })

  test("dispose-during-open closes the late client", async () => {
    const bus = new HookBus()
    let release!: (s: DiagnosticsSession) => void
    const live = session([errDiag("x")])
    const handle = attachLspDiagnosticsHook({
      hooks: bus,
      push: { push: () => {} },
      editTools: EDIT,
      open: () =>
        new Promise((resolve) => {
          release = resolve
        }),
      cwd: "/work",
    })
    const pending = emitEdit(bus)
    await Bun.sleep(10)
    const disposed = handle.dispose()
    release(live)
    await Promise.all([pending, disposed])
    expect(live.stopped).toBe(1)
  })

  test("dispose during diagnostics does not inject", async () => {
    const bus = new HookBus()
    const pushed: HookPromptInject[] = []
    let release!: () => void
    const live = session([errDiag("late")])
    live.diagnostics = () =>
      new Promise<DiagnosticItem[]>((resolve) => {
        release = () => resolve([errDiag("late")])
      })
    const handle = attachLspDiagnosticsHook({
      hooks: bus,
      push: { push: (e) => pushed.push(e) },
      editTools: EDIT,
      open: async () => live,
      cwd: "/work",
    })
    const pending = emitEdit(bus)
    await Bun.sleep(10)
    const disposed = handle.dispose()
    release()
    await Promise.all([pending, disposed])
    expect(pushed).toHaveLength(0)
    expect(live.stopped).toBe(1)
  })

  test("post-dispose edit does not open a new client", async () => {
    const bus = new HookBus()
    let n = 0
    const handle = attachLspDiagnosticsHook({
      hooks: bus,
      push: { push: () => {} },
      editTools: EDIT,
      open: async () => {
        n += 1
        return session([errDiag("x")])
      },
      cwd: "/work",
    })
    await handle.dispose()
    await emitEdit(bus)
    expect(n).toBe(0)
  })
})
