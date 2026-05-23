/**
 * Hellgate — `shadow_rewind` tool (ADR-0119).
 *
 * Seal:
 *   - metadata (name / read-only / concurrency-safe / hitlTier)
 *   - schema validation (defaults + reject invalid enum + boolean overrides)
 *   - exact-optional spread (absent input keys never reach the port)
 *   - typed-error mapping (`ShadowOdbError` → ok:false starting with code)
 *   - non-typed error bubbles (programmer-bug convention from `_shared.safeRun`)
 *   - signal aborted before start (port not called)
 *   - happy paths (default policy + discard policy in output text)
 *
 * Strategy: hand-rolled fake `ShadowOdb` (no real git binary, no real
 * filesystem) — every method is mockable. Calls are recorded for argument
 * shape assertions.
 */

import { describe, expect, test } from "bun:test"
import { type ShadowOdb, ShadowOdbError } from "@/storage"
import { shadowRewindTool } from "@/tool/shadow"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

interface RewindCall {
  readonly workspaceRoot: string
  readonly opts: Readonly<Record<string, unknown>> | undefined
}

interface FakeOdb extends ShadowOdb {
  readonly rewindCalls: RewindCall[]
}

const fakeOdb = (overrides?: Partial<ShadowOdb>): FakeOdb => {
  const calls: RewindCall[] = []
  const base: ShadowOdb = {
    init: async () => ({ shadowDir: "/tmp/x", workspaceHash: "abc" }),
    registerHead: async () => "sha-1",
    diffSinceLast: async () => "",
    diffWorkspaceSinceLast: async () => "",
    rewindToLast: async (workspaceRoot: string, opts) => {
      // Capture argument shape (incl. absent vs explicit-undefined keys).
      calls.push({
        workspaceRoot,
        opts: opts === undefined ? undefined : { ...opts },
      })
    },
    listSnapshots: async () => [],
    cleanup: async () => 0,
  }
  const merged: ShadowOdb = { ...base, ...(overrides ?? {}) }
  // If overrides replaced rewindToLast, wrap so we still record the call.
  const finalRewind = merged.rewindToLast
  merged.rewindToLast = async (workspaceRoot, opts) => {
    calls.push({
      workspaceRoot,
      opts: opts === undefined ? undefined : { ...opts },
    })
    return finalRewind(workspaceRoot, opts)
  }
  return Object.assign(merged, { rewindCalls: calls }) as FakeOdb
}

const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: "/work/proj",
  signal: signal ?? new AbortController().signal,
})

interface ExecutableTool {
  execute(input: unknown, c: ToolContext): AsyncIterable<ToolEvent>
}

const collect = async (
  tool: ExecutableTool,
  input: unknown,
  context: ToolContext = ctx(),
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input, context)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

/* ------------------------------------------------------------------ */
/* A. Tool metadata                                                    */
/* ------------------------------------------------------------------ */

describe("shadow_rewind — metadata", () => {
  test("HELL-A1: name === 'shadow_rewind'", () => {
    const t = shadowRewindTool(fakeOdb())
    expect(t.name).toBe("shadow_rewind")
  })

  test("HELL-A2: isReadOnly() === false (mutating)", () => {
    const t = shadowRewindTool(fakeOdb())
    expect(t.isReadOnly()).toBe(false)
  })

  test("HELL-A3: isConcurrencySafe() === false (per-workspace lock)", () => {
    const t = shadowRewindTool(fakeOdb())
    expect(t.isConcurrencySafe({})).toBe(false)
  })

  test("HELL-A4: hitlTier() === 'always-confirm' (destructive op)", () => {
    const t = shadowRewindTool(fakeOdb())
    expect(t.hitlTier?.({})).toBe("always-confirm")
  })
})

/* ------------------------------------------------------------------ */
/* B. Input validation                                                 */
/* ------------------------------------------------------------------ */

describe("shadow_rewind — input validation", () => {
  test("HELL-B5: empty input {} ⇒ ok:true (defaults used)", async () => {
    const odb = fakeOdb()
    const t = shadowRewindTool(odb)
    const r = await collect(t, {})
    expect(r.ok).toBe(true)
    expect(odb.rewindCalls).toHaveLength(1)
  })

  test("HELL-B6: {untracked:'preserve'} ⇒ rewindToLast called with exact opts", async () => {
    const odb = fakeOdb()
    const t = shadowRewindTool(odb)
    const r = await collect(t, { untracked: "preserve" })
    expect(r.ok).toBe(true)
    expect(odb.rewindCalls).toHaveLength(1)
    expect(odb.rewindCalls[0]?.opts).toEqual({ untracked: "preserve" })
  })

  test("HELL-B7: {untracked:'invalid'} ⇒ ok:false 'invalid input: ...'", async () => {
    const odb = fakeOdb()
    const t = shadowRewindTool(odb)
    const r = await collect(t, { untracked: "invalid" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/^invalid input:/)
    // port not called when schema fails
    expect(odb.rewindCalls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* C. exact-optional spread                                            */
/* ------------------------------------------------------------------ */

describe("shadow_rewind — exact-optional spread", () => {
  test("HELL-C8: {} ⇒ opts arg has NEITHER 'untracked' NOR 'allowDirtyMerge' key", async () => {
    const odb = fakeOdb()
    const t = shadowRewindTool(odb)
    await collect(t, {})
    const arg = odb.rewindCalls[0]?.opts
    expect(arg).toBeDefined()
    if (!arg) throw new Error("unreachable — checked above")
    expect("untracked" in arg).toBe(false)
    expect("allowDirtyMerge" in arg).toBe(false)
  })

  test("HELL-C9: {allowDirtyMerge:true} ⇒ has allowDirtyMerge:true but NO 'untracked' key", async () => {
    const odb = fakeOdb()
    const t = shadowRewindTool(odb)
    await collect(t, { allowDirtyMerge: true })
    const arg = odb.rewindCalls[0]?.opts
    expect(arg).toBeDefined()
    if (!arg) throw new Error("unreachable — checked above")
    expect(arg).toEqual({ allowDirtyMerge: true })
    expect("untracked" in arg).toBe(false)
    expect(arg.allowDirtyMerge).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* D. Error mapping                                                    */
/* ------------------------------------------------------------------ */

describe("shadow_rewind — typed error mapping", () => {
  test("HELL-D10: ShadowOdbError('uninitialized') ⇒ ok:false output startsWith 'uninitialized:'", async () => {
    const odb = fakeOdb({
      rewindToLast: async () => {
        throw new ShadowOdbError("uninitialized", "no anchor")
      },
    })
    const t = shadowRewindTool(odb)
    const r = await collect(t, {})
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("uninitialized:")).toBe(true)
  })

  test("HELL-D11: ShadowOdbError('merge-in-progress') ⇒ ok:false 'merge-in-progress:'", async () => {
    const odb = fakeOdb({
      rewindToLast: async () => {
        throw new ShadowOdbError("merge-in-progress", "MERGE_HEAD exists")
      },
    })
    const t = shadowRewindTool(odb)
    const r = await collect(t, {})
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("merge-in-progress:")).toBe(true)
  })

  test("HELL-D12: ShadowOdbError('rewind-failed') ⇒ ok:false 'rewind-failed:'", async () => {
    const odb = fakeOdb({
      rewindToLast: async () => {
        throw new ShadowOdbError("rewind-failed", "checkout-index 128")
      },
    })
    const t = shadowRewindTool(odb)
    const r = await collect(t, {})
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("rewind-failed:")).toBe(true)
  })

  test("HELL-D13: non-ShadowOdbError BUBBLES (programmer bug convention)", async () => {
    const odb = fakeOdb({
      rewindToLast: async () => {
        throw new Error("boom — not a ShadowOdbError")
      },
    })
    const t = shadowRewindTool(odb)
    // Consumption must throw — the typed-error filter only catches
    // ShadowOdbError. Match `_shared.safeRun` convention.
    let caught: unknown
    try {
      await collect(t, {})
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("boom — not a ShadowOdbError")
  })
})

/* ------------------------------------------------------------------ */
/* E. Signal & success                                                 */
/* ------------------------------------------------------------------ */

describe("shadow_rewind — signal + success", () => {
  test("HELL-E14: signal aborted BEFORE call ⇒ port NOT called + 'aborted before start'", async () => {
    const ac = new AbortController()
    ac.abort()
    const odb = fakeOdb()
    const t = shadowRewindTool(odb)
    const r = await collect(t, {}, ctx(ac.signal))
    expect(r.ok).toBe(false)
    expect(r.output).toBe("aborted before start")
    expect(odb.rewindCalls).toHaveLength(0)
  })

  test("HELL-E15: success with default policy ⇒ output mentions 'preserve' + 'Pre-rewind ref saved'", async () => {
    const odb = fakeOdb()
    const t = shadowRewindTool(odb)
    const r = await collect(t, {})
    expect(r.ok).toBe(true)
    expect(r.output).toContain("preserve")
    expect(r.output).toContain("Pre-rewind ref saved")
  })

  test("HELL-E16: success with discard ⇒ output mentions 'discard'", async () => {
    const odb = fakeOdb()
    const t = shadowRewindTool(odb)
    const r = await collect(t, { untracked: "discard" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("discard")
  })
})
