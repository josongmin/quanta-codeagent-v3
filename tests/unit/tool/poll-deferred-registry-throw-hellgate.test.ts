/** Hellgate — poll_deferred NO-THROW boundary against a THROWING REGISTRY.
 *
 *  Round-1 audit gap: src/tool/poll_deferred.ts:~109-124 wraps the
 *  `registry.poll(...)` / `registry.await(...)` call in a try/catch that maps
 *  ANY throw to a single `ok:false` result whose output contains
 *  `poll_deferred: registry-error: <msg>`. The existing async-tool-dispatch
 *  hellgate only ever exercises a throwing WORKER (the registry itself behaves
 *  — it CLASSIFIES a worker throw as a `failed` Status). It NEVER drives the
 *  registry-catch branch, because `DefaultDeferredResultRegistry.poll/await`
 *  do not throw.
 *
 *  Here we inject a duck-typed registry whose `poll`/`await` THROW directly,
 *  and assert:
 *    - poll path (no awaitMs): synchronous `poll` throw → ok:false registry-error
 *    - await path (awaitMs>0): rejecting `await` → ok:false registry-error
 *    - failure.mode === "error", modelVisibleError carries the raw message
 *    - the tool's async iterator DRAINS (never rejects)
 *    - exactly one terminal result is yielded
 */

import { describe, expect, test } from "bun:test"
import type { DeferredResultRegistry } from "@/tool/deferred/port"
import type { DeferredHandle, Status } from "@/tool/deferred/types"
import { pollDeferredTool } from "@/tool/poll_deferred"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/** Minimal registry whose probe methods THROW. The other members are present
 *  only to satisfy the structural port; they are never reached on these paths. */
const throwingRegistry = (over: Partial<DeferredResultRegistry> = {}): DeferredResultRegistry => ({
  register: (): DeferredHandle => ({ id: "deferred-x", createdAt: 0 }),
  poll: (): Status => {
    throw new Error("registry poll blew up")
  },
  await: async (): Promise<Status> => {
    throw new Error("registry await blew up")
  },
  cancel: (): void => undefined,
  list: (): readonly DeferredHandle[] => [],
  ...over,
})

const ctx = (): ToolContext => ({ cwd: "/tmp", signal: new AbortController().signal })

const drainNoReject = async (tool: Tool, input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const e of tool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>) {
    if (e.type === "result") result = e.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

describe("poll_deferred — synchronous registry.poll() throws (no awaitMs)", () => {
  test("maps to a single ok:false registry-error, iterator does NOT reject", async () => {
    const reg = throwingRegistry()
    const r = await drainNoReject(pollDeferredTool(reg), { handle: "h1" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("poll_deferred: registry-error:")
    expect(r.output).toContain("registry poll blew up")
    expect(r.failure?.mode).toBe("error")
    if (r.failure?.mode === "error")
      expect(r.failure.modelVisibleError).toBe("registry poll blew up")
  })

  test("awaitMs:0 still routes through the synchronous poll path", async () => {
    const reg = throwingRegistry()
    const r = await drainNoReject(pollDeferredTool(reg), { handle: "h1", awaitMs: 0 })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("registry poll blew up")
  })
})

describe("poll_deferred — registry.await() rejects (awaitMs>0)", () => {
  test("maps to a single ok:false registry-error, iterator does NOT reject", async () => {
    const reg = throwingRegistry()
    const r = await drainNoReject(pollDeferredTool(reg), { handle: "h1", awaitMs: 50 })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("poll_deferred: registry-error:")
    expect(r.output).toContain("registry await blew up")
    expect(r.failure?.mode).toBe("error")
    if (r.failure?.mode === "error")
      expect(r.failure.modelVisibleError).toBe("registry await blew up")
  })

  test("await throwing SYNCHRONOUSLY (before returning a promise) is also caught", async () => {
    const reg = throwingRegistry({
      await: (() => {
        throw new Error("await sync explode")
      }) as DeferredResultRegistry["await"],
    })
    const r = await drainNoReject(pollDeferredTool(reg), { handle: "h1", awaitMs: 10 })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("registry-error:")
    expect(r.output).toContain("await sync explode")
  })
})

describe("poll_deferred — no-throw contract shape", () => {
  test("exactly one terminal result event on a throwing registry", async () => {
    const reg = throwingRegistry()
    const events: ToolEvent[] = []
    for await (const e of pollDeferredTool(reg).execute({ handle: "h1" } as never, ctx())) {
      events.push(e)
    }
    expect(events.filter((e) => e.type === "result")).toHaveLength(1)
  })

  test("registry catch fires BEFORE the renderStatus/completed-unwrap path", async () => {
    // If the catch did NOT fire, a poll that returned a malformed Status would
    // crash renderStatus; instead the throw is intercepted and reported.
    const reg = throwingRegistry()
    const r = await drainNoReject(pollDeferredTool(reg), { handle: "h1" })
    // The output is the registry-error envelope, NOT a rendered [pending]/[completed].
    expect(r.output.startsWith("poll_deferred: registry-error:")).toBe(true)
    expect(r.output).not.toContain("[pending]")
    expect(r.output).not.toContain("completed via=deferred")
  })
})
