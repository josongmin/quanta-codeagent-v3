/**
 * Hellgate — LSP call-hierarchy TOOLS (RFC jun-6).
 *
 * Drives the two new read-only tools (`lsp_incoming_calls` /
 * `lsp_outgoing_calls`) through a FAKE `LspNavProvider` (no real LSP server).
 * Seals the adversarial / edge contract:
 *   - incoming returns callers + their exact `fromRanges`, in order, no loss.
 *   - outgoing returns callees with the call-site lines inside this function.
 *   - unsupported server ⇒ session returns `null` ⇒ clean "not supported here"
 *     `ok:true`, never throws.
 *   - resolved-but-empty ⇒ `[]` ⇒ "no callers"/"no callees" (distinct from null).
 *   - both tools are read-only + not concurrency-safe.
 *   - pre-aborted signal ⇒ "aborted before start", provider never opened.
 *   - the abort signal is threaded into the session call.
 */

import { describe, expect, test } from "bun:test"
import { nullLspNavProvider } from "@/tool/lsp_nav"
import type { NavCallHierarchyEntry } from "@/tool/lsp_nav/types"
import { emptyTrace, fakeProvider, findTool, run } from "./lsp-nav-fixtures"

const r = (sl: number, sc: number, el: number, ec: number): NavCallHierarchyEntry["range"] => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
})

const entry = (
  name: string,
  selLine: number,
  selCol: number,
  fromRanges: NavCallHierarchyEntry["fromRanges"],
): NavCallHierarchyEntry => ({
  name,
  kind: "function",
  uri: "file:///repo/caller.ts",
  range: r(selLine, 0, selLine + 5, 1),
  selectionRange: r(selLine, selCol, selLine, selCol + name.length),
  fromRanges,
})

describe("lsp_incoming_calls — callers + fromRanges fidelity", () => {
  test("returns each caller with its exact call-site lines (1-based, ordered, no dedup-loss)", async () => {
    const trace = emptyTrace()
    const t = findTool<{ path: string; line: number; character: number }>(
      "lsp_incoming_calls",
      fakeProvider(
        {
          incomingCalls: async (fp, p) => {
            trace.filePath = fp
            trace.pos = p
            return [
              // caller `bar` with 3 distinct call sites — must render all 3 in order.
              entry("bar", 10, 9, [r(12, 4, 12, 7), r(14, 8, 14, 11), r(12, 4, 12, 7)]),
              entry("baz", 20, 9, [r(22, 2, 22, 5)]),
            ]
          },
        },
        trace,
      ),
    )
    const { result } = await run(t, { path: "src/foo.ts", line: 1, character: 1 })
    expect(trace.pos).toEqual({ line: 0, character: 0 })
    expect(result.ok).toBe(true)
    expect(result.output).toContain("incoming calls: 2 result(s)")
    // bar: 3 call sites, rendered 1-based, IN ORDER, duplicate NOT collapsed.
    expect(result.output).toContain(
      "function bar /repo/caller.ts:11:10 · 3 call site(s) [13:5, 15:9, 13:5]",
    )
    expect(result.output).toContain("function baz /repo/caller.ts:21:10 · 1 call site(s) [23:3]")
  })

  test("unsupported server ⇒ null ⇒ 'not supported here', ok:true, no throw", async () => {
    const t = findTool(
      "lsp_incoming_calls",
      fakeProvider({ incomingCalls: async () => null }, emptyTrace()),
    )
    const { result } = await run(t, { path: "a.ts", line: 1, character: 1 })
    expect(result.ok).toBe(true)
    expect(result.output).toBe("incoming calls: not supported here")
  })

  test("resolved-but-no-callers ⇒ [] ⇒ 'no callers' (distinct from null)", async () => {
    const t = findTool(
      "lsp_incoming_calls",
      fakeProvider({ incomingCalls: async () => [] }, emptyTrace()),
    )
    const { result } = await run(t, { path: "a.ts", line: 1, character: 1 })
    expect(result.ok).toBe(true)
    expect(result.output).toBe("incoming calls: no callers")
  })

  test("an entry with zero fromRanges renders '0 call site(s)' with no bracket list", async () => {
    const t = findTool(
      "lsp_incoming_calls",
      fakeProvider({ incomingCalls: async () => [entry("solo", 1, 0, [])] }, emptyTrace()),
    )
    const { result } = await run(t, { path: "a.ts", line: 1, character: 1 })
    expect(result.output).toContain("· 0 call site(s)")
    expect(result.output).not.toContain("[]")
  })

  test("unavailable provider ⇒ ok:false (never fails the turn structurally)", async () => {
    const t = findTool("lsp_incoming_calls", nullLspNavProvider)
    const { result } = await run(t, { path: "a.ts", line: 1, character: 1 })
    expect(result.ok).toBe(false)
    expect(result.output).toContain("lsp_incoming_calls unavailable: no language server configured")
  })

  test("pre-aborted signal ⇒ 'aborted before start', provider NEVER opened", async () => {
    const ac = new AbortController()
    ac.abort()
    const trace = emptyTrace()
    const t = findTool("lsp_incoming_calls", fakeProvider({}, trace))
    const { result } = await run(t, { path: "a.ts", line: 1, character: 1 }, ac.signal)
    expect(result.ok).toBe(false)
    expect(result.output).toBe("aborted before start")
    expect(trace.opened.filePath).toBeUndefined()
  })
})

describe("lsp_outgoing_calls — callees", () => {
  test("returns each callee + call-site line inside this function", async () => {
    const trace = emptyTrace()
    const t = findTool<{ path: string; line: number; character: number }>(
      "lsp_outgoing_calls",
      fakeProvider(
        {
          outgoingCalls: async (fp, p) => {
            trace.filePath = fp
            trace.pos = p
            return [entry("foo", 0, 9, [r(3, 4, 3, 7)])]
          },
        },
        trace,
      ),
    )
    const { result } = await run(t, { path: "src/bar.ts", line: 2, character: 3 })
    expect(trace.pos).toEqual({ line: 1, character: 2 })
    expect(result.ok).toBe(true)
    expect(result.output).toContain("outgoing calls: 1 result(s)")
    expect(result.output).toContain("function foo /repo/caller.ts:1:10 · 1 call site(s) [4:5]")
  })

  test("null ⇒ 'not supported here'; [] ⇒ 'no callees'", async () => {
    const tNull = findTool(
      "lsp_outgoing_calls",
      fakeProvider({ outgoingCalls: async () => null }, emptyTrace()),
    )
    expect((await run(tNull, { path: "a.ts", line: 1, character: 1 })).result.output).toBe(
      "outgoing calls: not supported here",
    )
    const tEmpty = findTool(
      "lsp_outgoing_calls",
      fakeProvider({ outgoingCalls: async () => [] }, emptyTrace()),
    )
    expect((await run(tEmpty, { path: "a.ts", line: 1, character: 1 })).result.output).toBe(
      "outgoing calls: no callees",
    )
  })

  test("mid-flight abort is forwarded to the session", async () => {
    const ac = new AbortController()
    const trace = emptyTrace()
    const t = findTool(
      "lsp_outgoing_calls",
      fakeProvider(
        {
          outgoingCalls: async (_fp, _p, signal) => {
            trace.signal = signal
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("aborted mid-request")), {
                once: true,
              })
            })
            return []
          },
        },
        trace,
      ),
    )
    const pending = run(t, { path: "a.ts", line: 1, character: 1 }, ac.signal)
    setTimeout(() => ac.abort(), 10)
    const { result } = await pending
    expect(trace.signal).toBe(ac.signal)
    expect(result.ok).toBe(false)
    expect(result.output).toBe("lsp_outgoing_calls failed: aborted mid-request")
  })
})

describe("call-hierarchy tools — read-only + concurrency posture", () => {
  test("both tools are read-only and NOT concurrency-safe", () => {
    for (const name of ["lsp_incoming_calls", "lsp_outgoing_calls"]) {
      const t = findTool(name, nullLspNavProvider)
      expect(t.isReadOnly()).toBe(true)
      expect(t.isConcurrencySafe?.({ path: "a.ts", line: 1, character: 1 })).toBe(false)
    }
  })

  test("input schema rejects line/character < 1 (1-based guard)", () => {
    const t = findTool("lsp_incoming_calls", nullLspNavProvider)
    expect(t.inputSchema.safeParse({ path: "a.ts", line: 0, character: 1 }).success).toBe(false)
    expect(t.inputSchema.safeParse({ path: "a.ts", line: 1, character: 0 }).success).toBe(false)
    expect(t.inputSchema.safeParse({ path: "a.ts", line: 1, character: 1 }).success).toBe(true)
  })
})
