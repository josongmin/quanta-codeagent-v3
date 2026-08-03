/**
 * RFC02-2 — `bash_kill` owner-scoped kill product wire hellgate
 * (src/tool/bash/kill.ts).
 *
 * The model tool `bash_kill` MUST kill ONLY through `registry.killOwned(id,
 * ctx.ownerId)`. This test drives the REAL tool against a REAL (injected)
 * registry and asserts the product-level refusals — not just the registry unit:
 *
 *   1. CROSS-OWNER — a bash_kill under owner B cannot kill owner A's shell.
 *      Typed refusal; A's child stays alive (kill spy = 0). Red-on-injection:
 *      revert kill.ts to the unscoped `registry.kill` and this goes green-kills.
 *   2. NO-OWNER CALLER — a ctx WITHOUT `ownerId` (legacy surface) is refused
 *      outright (fail-closed, no unscoped kill from the model).
 *   3. AMBIGUOUS PREFIX — a prefix matching >1 of the caller's shells refuses.
 *   4. LEGACY-UNOWNED SHELL — a shell adopted with no owner is un-killable by
 *      every owner.
 *   5. OWN KILL — the owner kills its own shell (positive control) and the
 *      child is signalled.
 */

import { describe, expect, test } from "bun:test"
import { createBashBgRegistry } from "@/runtime/bash-bg-registry"
import { createBoundedBuffer } from "@/runtime/bounded-buffer"
import { makeBashKillTool } from "@/tool/bash/kill"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const ctx = (ownerId?: string): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  ...(ownerId !== undefined ? { ownerId } : {}),
})

const run = async (
  tool: { execute: (i: never, c: ToolContext) => AsyncIterable<ToolEvent> },
  input: unknown,
  c: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const makeAdoptable = () => {
  const stdout = createBoundedBuffer(200_000)
  const stderr = createBoundedBuffer(200_000)
  let exitResolve!: (code: number) => void
  const exited = new Promise<number>((res) => {
    exitResolve = res
  })
  let drainsResolve!: () => void
  const drainsDone = new Promise<void>((res) => {
    drainsResolve = res
  })
  const spy = { kills: 0 }
  return {
    spy,
    adoptArgs(overrides: Record<string, unknown> = {}) {
      return {
        command: "sleep 999",
        cwd: "/tmp",
        kill: () => {
          spy.kills += 1
          drainsResolve()
          exitResolve(137)
        },
        disarm: () => {},
        stdout,
        stderr,
        exited,
        drainsDone,
        ...overrides,
      }
    },
  }
}

describe("RFC02-2 — bash_kill is owner-scoped", () => {
  test("owner B cannot kill owner A's shell (typed refusal, child alive)", async () => {
    const reg = createBashBgRegistry({ maxEntries: 8 })
    const childA = makeAdoptable()
    const { id } = await reg.adopt(childA.adoptArgs({ ownerId: "A", id: "aaa" }))

    const res = await run(makeBashKillTool(reg), { shell_id: id }, ctx("B"))
    expect(res.ok).toBe(false)
    expect(res.failure).toEqual({ mode: "rejected", reason: "not_owned" })
    expect(childA.spy.kills).toBe(0)
    expect(reg.get(id)?.status).toBe("running")
  })

  test("a caller with NO ownerId is refused (no unscoped model kill)", async () => {
    const reg = createBashBgRegistry({ maxEntries: 8 })
    const child = makeAdoptable()
    const { id } = await reg.adopt(child.adoptArgs({ ownerId: "A", id: "aaa" }))

    const res = await run(makeBashKillTool(reg), { shell_id: id }, ctx(/* no owner */))
    expect(res.ok).toBe(false)
    expect(child.spy.kills).toBe(0)
    expect(reg.get(id)?.status).toBe("running")
  })

  test("an ambiguous prefix refuses without killing", async () => {
    const reg = createBashBgRegistry({ maxEntries: 8 })
    const c1 = makeAdoptable()
    const c2 = makeAdoptable()
    await reg.adopt(c1.adoptArgs({ ownerId: "A", id: "pre-1" }))
    await reg.adopt(c2.adoptArgs({ ownerId: "A", id: "pre-2" }))

    const res = await run(makeBashKillTool(reg), { shell_id: "pre" }, ctx("A"))
    expect(res.ok).toBe(false)
    expect(res.failure).toEqual({ mode: "rejected", reason: "ambiguous" })
    expect(c1.spy.kills).toBe(0)
    expect(c2.spy.kills).toBe(0)
  })

  test("a legacy unowned shell is un-killable by any owner", async () => {
    const reg = createBashBgRegistry({ maxEntries: 8 })
    const legacy = makeAdoptable()
    const { id } = await reg.adopt(legacy.adoptArgs({ id: "legacy-1" })) // no owner

    const res = await run(makeBashKillTool(reg), { shell_id: id }, ctx("A"))
    expect(res.ok).toBe(false)
    expect(res.failure).toEqual({ mode: "rejected", reason: "not_owned" })
    expect(legacy.spy.kills).toBe(0)
  })

  test("the owner kills its own shell (positive control)", async () => {
    const reg = createBashBgRegistry({ maxEntries: 8 })
    const child = makeAdoptable()
    const { id } = await reg.adopt(child.adoptArgs({ ownerId: "A", id: "mine-1" }))

    const res = await run(makeBashKillTool(reg), { shell_id: id }, ctx("A"))
    expect(res.ok).toBe(true)
    expect(res.output).toContain(id)
    expect(child.spy.kills).toBeGreaterThanOrEqual(1)
  })
})
