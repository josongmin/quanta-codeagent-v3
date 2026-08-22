/** Hellgate — `shadow_verify` NO-THROW boundary against a REJECTING port.
 *
 *  Round-1 audit gap: shadow-verify/index.ts wraps `port.verify(...)` in a
 *  try/catch (Tool contract §2). The duck-typed `ShadowVerifyPort` is adapted
 *  from `@/agent`; a rejecting adapter MUST NOT reject the tool's async
 *  iterator (that hangs/corrupts the dispatch loop). Any throw maps to a
 *  single terminal `ok:false` result:
 *      output:  "shadow_verify: backend-error: <msg>"
 *      failure: { mode: "error", modelVisibleError: <msg> }
 *
 *  The existing shadow-verify hellgate only drives a well-behaved port. This
 *  battery proves the catch branch:
 *    - verify() rejects (async)      → ok:false backend-error, no iterator reject
 *    - verify() throws synchronously → same collapse
 *    - the `progress` event is still emitted BEFORE the error result
 *    - exactly one terminal result; failure.mode === "error".
 */

import { describe, expect, test } from "bun:test"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { type ShadowVerifyPortMirror, shadowVerifyTool } from "@/tool/shadow-verify"

const makeCtx = (signal?: AbortSignal): ToolContext =>
  ({
    cwd: "/tmp",
    signal: signal ?? new AbortController().signal,
  }) as ToolContext

/** A port whose verify REJECTS. */
const rejectingPort = (msg: string): ShadowVerifyPortMirror => ({
  async verify() {
    throw new Error(msg)
  },
})

/** A port whose verify throws SYNCHRONOUSLY (before returning a promise). */
const syncThrowingPort = (msg: string): ShadowVerifyPortMirror =>
  ({
    verify: () => {
      throw new Error(msg)
    },
  }) as unknown as ShadowVerifyPortMirror

const collect = async (tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolEvent[]> => {
  const out: ToolEvent[] = []
  // Any rejection from the iterator propagates out of this for-await and fails
  // the awaiting test loudly — proving the NO-THROW contract.
  for await (const e of tool.execute(input, ctx)) out.push(e)
  return out
}

const validInput = { patch: "*** Begin Patch\n*** End Patch", checks: ["lint"] as const }

describe("shadow_verify — port.verify() rejects (async)", () => {
  test("collapses to a single ok:false backend-error; iterator does NOT reject", async () => {
    const tool = shadowVerifyTool(rejectingPort("worktree provisioning failed"))
    const events = await collect(tool, validInput, makeCtx())
    const results = events.filter((e) => e.type === "result")
    expect(results).toHaveLength(1)
    const r = results[0]
    expect(r?.type).toBe("result")
    if (r?.type !== "result") throw new Error("unreachable")
    expect(r.result.ok).toBe(false)
    expect(r.result.output).toContain("shadow_verify: backend-error:")
    expect(r.result.output).toContain("worktree provisioning failed")
    expect(r.result.failure?.mode).toBe("error")
    if (r.result.failure?.mode === "error")
      expect(r.result.failure.modelVisibleError).toBe("worktree provisioning failed")
  })

  test("the progress event is still emitted BEFORE the error result", async () => {
    const tool = shadowVerifyTool(rejectingPort("boom"))
    const events = await collect(tool, validInput, makeCtx())
    const progressIdx = events.findIndex((e) => e.type === "progress")
    const resultIdx = events.findIndex((e) => e.type === "result")
    expect(progressIdx).toBeGreaterThanOrEqual(0)
    expect(resultIdx).toBeGreaterThan(progressIdx)
  })
})

describe("shadow_verify — port.verify() throws synchronously", () => {
  test("synchronous throw is also collapsed to ok:false backend-error", async () => {
    const tool = shadowVerifyTool(syncThrowingPort("sync overlay crash"))
    const events = await collect(tool, validInput, makeCtx())
    const results = events.filter((e) => e.type === "result")
    expect(results).toHaveLength(1)
    const r = results[0]
    if (r?.type !== "result") throw new Error("unreachable")
    expect(r.result.ok).toBe(false)
    expect(r.result.output).toContain("shadow_verify: backend-error:")
    expect(r.result.output).toContain("sync overlay crash")
    expect(r.result.failure?.mode).toBe("error")
  })
})

describe("shadow_verify — abort short-circuits BEFORE the (throwing) port", () => {
  test("pre-aborted signal yields 'aborted before start', port never consulted", async () => {
    let consulted = false
    const port: ShadowVerifyPortMirror = {
      async verify() {
        consulted = true
        throw new Error("should never run")
      },
    }
    const ac = new AbortController()
    ac.abort()
    const events = await collect(shadowVerifyTool(port), validInput, makeCtx(ac.signal))
    const results = events.filter((e) => e.type === "result")
    expect(results).toHaveLength(1)
    const r = results[0]
    if (r?.type !== "result") throw new Error("unreachable")
    expect(r.result.ok).toBe(false)
    expect(r.result.output).toContain("aborted before start")
    expect(consulted).toBe(false)
  })
})
