import { describe, expect, test } from "bun:test"
import { HookBus } from "@/agent/hooks"
import { attachLspDiagnosticsHook } from "@/agent/lsp-diagnostics-hook"
import type { DiagnosticItem, DiagnosticsSession } from "@/tool"

const EDIT = new Map<string, (input: unknown) => string | null>([
  ["edit", (i) => (i as { path?: string }).path ?? null],
])

describe("P2-A-05 edit-triggered consumer retry", () => {
  test("null opener then live session injects on the second edit", async () => {
    const bus = new HookBus()
    const pushed: string[] = []
    let n = 0
    const live: DiagnosticsSession = {
      diagnostics: async (): Promise<DiagnosticItem[]> => [
        {
          severity: "error",
          message: "recovered",
          range: { start: { line: 2, character: 0 } },
        },
      ],
      stop: async () => {},
    }
    attachLspDiagnosticsHook({
      hooks: bus,
      push: { push: (e) => pushed.push(e.injectAfterSystem ?? "") },
      editTools: EDIT,
      open: async () => {
        n += 1
        return n === 1 ? null : live
      },
      cwd: "/work",
    })
    await bus.emit({
      type: "post_tool_use",
      name: "edit",
      input: { path: "/work/a.ts" },
      ok: true,
      output: "edited",
    })
    await bus.emit({
      type: "post_tool_use",
      name: "edit",
      input: { path: "/work/a.ts" },
      ok: true,
      output: "edited",
    })
    expect(n).toBe(2)
    expect(pushed.some((t) => t.includes("recovered"))).toBe(true)
  })
})
