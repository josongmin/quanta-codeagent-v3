/**
 * Hellgate — edit-after-diagnostics auto-injection hook (ADR-0381, A3).
 *
 * `attachLspDiagnosticsHook` registers a `post_tool_use` HANDLER that, after an
 * edit-class tool runs, fetches LSP diagnostics for the edited file and pushes
 * a `HookPromptInject` through the caller's `subagentPendingPrompt` port. The
 * loop folds that into the NEXT turn's prompt via the EXISTING ADR-0133
 * mechanism — `dispatch.ts` and `loop.ts` are NOT modified.
 *
 * Default-OFF: not calling `attachLspDiagnosticsHook` = byte-identical
 * (no `post_tool_use` handler registered).
 *
 * Seal:
 *   A. byte-identical when NOT attached (no handler on the bus)
 *   B. edit tool with diagnostics ⇒ a promptHook is pushed (with the rendered
 *      diagnostics text); non-edit tools ⇒ nothing pushed
 *   C. clean file (no diagnostics) ⇒ nothing pushed (no noise)
 *   D. per-session cache: N edits to files of the same language reuse ONE
 *      opened client (open called once, not per-hook)
 *   E. degrade-gracefully: provider open() returns null / throws ⇒ no push,
 *      no throw (a flaky LSP must never break the turn)
 */

import { describe, expect, test } from "bun:test"
import type { HookPromptInject } from "@/agent/hooks"
import { HookBus } from "@/agent/hooks"
import { attachLspDiagnosticsHook } from "@/agent/lsp-diagnostics-hook"
import type { DiagnosticItem, DiagnosticsSession } from "@/tool"

interface FakeSession extends DiagnosticsSession {
  readonly stopped: { count: number }
}

const session = (diags: DiagnosticItem[]): FakeSession => {
  const stopped = { count: 0 }
  return {
    stopped,
    diagnostics: async () => diags,
    stop: async () => {
      stopped.count += 1
    },
  }
}

const errDiag = (line: number, message: string): DiagnosticItem => ({
  severity: "error",
  message,
  range: { start: { line, character: 0 } },
})

/** Collector for the `subagentPendingPrompt` port. */
const collector = () => {
  const pushed: HookPromptInject[] = []
  return { push: (e: HookPromptInject) => pushed.push(e), pushed }
}

/** Edit-tool path-extractor map — caller-injected (no heuristics in module). */
const EDIT_TOOLS = new Map<string, (input: unknown) => string | null>([
  ["edit", (i) => (i as { path?: string }).path ?? null],
  ["write", (i) => (i as { path?: string }).path ?? null],
])

describe("attachLspDiagnosticsHook — default-OFF", () => {
  test("HELL-A1: NOT attached ⇒ no post_tool_use handler on the bus", async () => {
    const bus = new HookBus()
    // No attach call. Emitting post_tool_use must be a no-op (no handlers).
    const r = await bus.emit({
      type: "post_tool_use",
      name: "edit",
      input: { path: "/work/a.ts" },
      ok: true,
      output: "edited",
    })
    expect(r.promptHook).toBeUndefined()
  })
})

describe("attachLspDiagnosticsHook — injection", () => {
  test("HELL-B2: edit with diagnostics ⇒ promptHook pushed carrying the text", async () => {
    const bus = new HookBus()
    const c = collector()
    const open = async () => session([errDiag(2, "Type 'number' is not assignable to 'string'")])
    attachLspDiagnosticsHook({
      hooks: bus,
      push: c,
      editTools: EDIT_TOOLS,
      open,
      cwd: "/work",
    })
    await bus.emit({
      type: "post_tool_use",
      name: "edit",
      input: { path: "/work/a.ts" },
      ok: true,
      output: "edited",
    })
    expect(c.pushed).toHaveLength(1)
    const text = c.pushed[0]?.injectAfterSystem ?? c.pushed[0]?.injectBeforeUser ?? ""
    expect(text).toContain("not assignable")
    expect(text).toContain("/work/a.ts")
  })

  test("HELL-B3: non-edit tool ⇒ nothing pushed (extractor map gates it)", async () => {
    const bus = new HookBus()
    const c = collector()
    const open = async () => session([errDiag(0, "boom")])
    attachLspDiagnosticsHook({ hooks: bus, push: c, editTools: EDIT_TOOLS, open, cwd: "/work" })
    await bus.emit({
      type: "post_tool_use",
      name: "read",
      input: { path: "/work/a.ts" },
      ok: true,
      output: "...",
    })
    expect(c.pushed).toHaveLength(0)
  })

  test("HELL-C4: clean file (no diagnostics) ⇒ nothing pushed", async () => {
    const bus = new HookBus()
    const c = collector()
    const open = async () => session([])
    attachLspDiagnosticsHook({ hooks: bus, push: c, editTools: EDIT_TOOLS, open, cwd: "/work" })
    await bus.emit({
      type: "post_tool_use",
      name: "write",
      input: { path: "/work/clean.ts" },
      ok: true,
      output: "wrote",
    })
    expect(c.pushed).toHaveLength(0)
  })
})

describe("attachLspDiagnosticsHook — per-session cache", () => {
  test("HELL-D5: N edits to same-language files reuse ONE opened client", async () => {
    const bus = new HookBus()
    const c = collector()
    let opens = 0
    const shared = session([errDiag(1, "err")])
    const open = async () => {
      opens += 1
      return shared
    }
    attachLspDiagnosticsHook({ hooks: bus, push: c, editTools: EDIT_TOOLS, open, cwd: "/work" })
    for (const p of ["/work/a.ts", "/work/b.ts", "/work/c.ts"]) {
      await bus.emit({
        type: "post_tool_use",
        name: "edit",
        input: { path: p },
        ok: true,
        output: "edited",
      })
    }
    // 3 edits, but the cache means the client is opened ONCE for the .ts language.
    expect(opens).toBe(1)
    expect(c.pushed).toHaveLength(3)
    // The cached session is NOT stopped per-hook (it's reused).
    expect(shared.stopped.count).toBe(0)
  })
})

describe("attachLspDiagnosticsHook — degrade gracefully", () => {
  test("HELL-E6: open() returns null ⇒ no push, no throw", async () => {
    const bus = new HookBus()
    const c = collector()
    const open = async () => null
    attachLspDiagnosticsHook({ hooks: bus, push: c, editTools: EDIT_TOOLS, open, cwd: "/work" })
    await bus.emit({
      type: "post_tool_use",
      name: "edit",
      input: { path: "/work/a.ts" },
      ok: true,
      output: "edited",
    })
    expect(c.pushed).toHaveLength(0)
  })

  test("HELL-E7: diagnostics() throws ⇒ no push, no throw (turn never breaks)", async () => {
    const bus = new HookBus()
    const c = collector()
    const open = async (): Promise<DiagnosticsSession> => ({
      diagnostics: async () => {
        throw new Error("server crashed")
      },
      stop: async () => {},
    })
    attachLspDiagnosticsHook({ hooks: bus, push: c, editTools: EDIT_TOOLS, open, cwd: "/work" })
    const r = await bus.emit({
      type: "post_tool_use",
      name: "edit",
      input: { path: "/work/a.ts" },
      ok: true,
      output: "edited",
    })
    expect(c.pushed).toHaveLength(0)
    expect(r.deny).toBeNull()
  })
})
