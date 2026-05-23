/**
 * Hellgate — `shadow_snapshots` tool (ADR-0119).
 *
 * Seal:
 *   - metadata (name / read-only=true / concurrency-safe=true)
 *   - input validation (positive int + ≤200 cap)
 *   - output formatting (empty / singular / plural / showing-N / sha truncation)
 *   - typed-error mapping (`ShadowOdbError` → ok:false starting with code)
 *   - signal aborted before start (port not called)
 *   - determinism (same input + data ⇒ byte-identical output)
 */

import { describe, expect, test } from "bun:test"
import { type ShadowOdb, ShadowOdbError, type SnapshotMetadata } from "@/storage"
import { shadowSnapshotsTool } from "@/tool/shadow"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

interface FakeOdb extends ShadowOdb {
  readonly listCalls: { workspaceRoot: string }[]
}

const fakeOdb = (overrides?: Partial<ShadowOdb>): FakeOdb => {
  const calls: { workspaceRoot: string }[] = []
  const base: ShadowOdb = {
    init: async () => ({ shadowDir: "/tmp/x", workspaceHash: "abc" }),
    registerHead: async () => "sha-1",
    diffSinceLast: async () => "",
    diffWorkspaceSinceLast: async () => "",
    rewindToLast: async () => {},
    // ADR-0122 — extension methods. No-op defaults; tests override per case.
    restorePartial: async () => {},
    markVerified: async () => {},
    rewindToVerified: async () => {},
    // Plain default; the wrapper below is the sole call-recorder (avoids
    // double-counting when a test supplies its own `listSnapshots`).
    listSnapshots: async () => [],
    cleanup: async () => 0,
  }
  const merged: ShadowOdb = { ...base, ...(overrides ?? {}) }
  const finalList = merged.listSnapshots
  merged.listSnapshots = async (workspaceRoot) => {
    calls.push({ workspaceRoot })
    return finalList(workspaceRoot)
  }
  return Object.assign(merged, { listCalls: calls }) as FakeOdb
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

/** Build a deterministic snapshot list — fixed shas + timestamps so the
 *  formatter output is byte-stable for assertion. */
const snap = (n: number): SnapshotMetadata => ({
  ref: `refs/quanta/snapshots/pre-rewind-2026-05-24T00-00-0${n}Z`,
  sha: `${"a".repeat(40)}`.slice(0, 40 - String(n).length) + String(n),
  timestampSec: 1_716_000_000 + n,
})

/* ------------------------------------------------------------------ */
/* A. Tool metadata                                                    */
/* ------------------------------------------------------------------ */

describe("shadow_snapshots — metadata", () => {
  test("HELL-A1: name === 'shadow_snapshots'", () => {
    const t = shadowSnapshotsTool(fakeOdb())
    expect(t.name).toBe("shadow_snapshots")
  })

  test("HELL-A2: isReadOnly() === true", () => {
    const t = shadowSnapshotsTool(fakeOdb())
    expect(t.isReadOnly()).toBe(true)
  })

  test("HELL-A3: isConcurrencySafe() === true", () => {
    const t = shadowSnapshotsTool(fakeOdb())
    expect(t.isConcurrencySafe({})).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* B. Input validation                                                 */
/* ------------------------------------------------------------------ */

describe("shadow_snapshots — input validation", () => {
  test("HELL-B4: {limit:5} accepted", async () => {
    const odb = fakeOdb({ listSnapshots: async () => [snap(1), snap(2), snap(3)] })
    const t = shadowSnapshotsTool(odb)
    const r = await collect(t, { limit: 5 })
    expect(r.ok).toBe(true)
  })

  test("HELL-B5: {limit:-1} ⇒ ok:false invalid input", async () => {
    const odb = fakeOdb()
    const t = shadowSnapshotsTool(odb)
    const r = await collect(t, { limit: -1 })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/^invalid input:/)
    expect(odb.listCalls).toHaveLength(0)
  })

  test("HELL-B6: {limit:201} ⇒ ok:false invalid input (cap=200)", async () => {
    const odb = fakeOdb()
    const t = shadowSnapshotsTool(odb)
    const r = await collect(t, { limit: 201 })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/^invalid input:/)
    expect(odb.listCalls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* C. Output formatting                                                */
/* ------------------------------------------------------------------ */

describe("shadow_snapshots — output formatting", () => {
  test("HELL-C7: 0 snapshots ⇒ '(no snapshots — shadow store empty)'", async () => {
    const odb = fakeOdb({ listSnapshots: async () => [] })
    const t = shadowSnapshotsTool(odb)
    const r = await collect(t, {})
    expect(r.ok).toBe(true)
    expect(r.output).toBe("(no snapshots — shadow store empty)")
  })

  test("HELL-C8: 1 snapshot ⇒ header '1 snapshot:' (singular)", async () => {
    const odb = fakeOdb({ listSnapshots: async () => [snap(1)] })
    const t = shadowSnapshotsTool(odb)
    const r = await collect(t, {})
    expect(r.ok).toBe(true)
    expect(r.output.startsWith("1 snapshot:")).toBe(true)
  })

  test("HELL-C9: 2 snapshots ⇒ header '2 snapshots:' (plural)", async () => {
    const odb = fakeOdb({ listSnapshots: async () => [snap(1), snap(2)] })
    const t = shadowSnapshotsTool(odb)
    const r = await collect(t, {})
    expect(r.ok).toBe(true)
    expect(r.output.startsWith("2 snapshots:")).toBe(true)
  })

  test("HELL-C10: limit=1 + 3 snapshots ⇒ '(showing 1)' header + only 1 line", async () => {
    const odb = fakeOdb({ listSnapshots: async () => [snap(1), snap(2), snap(3)] })
    const t = shadowSnapshotsTool(odb)
    const r = await collect(t, { limit: 1 })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("(showing 1)")
    // Header line + one entry line = 2 lines total.
    expect(r.output.split("\n")).toHaveLength(2)
  })

  test("HELL-C11: sha truncated to 12 chars in the line output", async () => {
    const fixed: SnapshotMetadata = {
      ref: "refs/quanta/snapshots/last-registered",
      sha: "0123456789abcdef0123456789abcdef01234567",
      timestampSec: 1_716_000_000,
    }
    const odb = fakeOdb({ listSnapshots: async () => [fixed] })
    const t = shadowSnapshotsTool(odb)
    const r = await collect(t, {})
    expect(r.ok).toBe(true)
    expect(r.output).toContain("0123456789ab")
    // The 13th char must NOT appear in the rendered line position.
    expect(r.output).not.toContain("0123456789abc")
  })
})

/* ------------------------------------------------------------------ */
/* D. Error mapping + signal                                           */
/* ------------------------------------------------------------------ */

describe("shadow_snapshots — error mapping + signal", () => {
  test("HELL-D12: ShadowOdbError('git-failed') ⇒ ok:false 'git-failed: ...'", async () => {
    const odb = fakeOdb({
      listSnapshots: async () => {
        throw new ShadowOdbError("git-failed", "for-each-ref exited 128")
      },
    })
    const t = shadowSnapshotsTool(odb)
    const r = await collect(t, {})
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("git-failed:")).toBe(true)
  })

  test("HELL-D13: signal aborted ⇒ listSnapshots NOT called", async () => {
    const ac = new AbortController()
    ac.abort()
    const odb = fakeOdb({ listSnapshots: async () => [snap(1)] })
    const t = shadowSnapshotsTool(odb)
    const r = await collect(t, {}, ctx(ac.signal))
    expect(r.ok).toBe(false)
    expect(r.output).toBe("aborted before start")
    expect(odb.listCalls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* E. Determinism                                                      */
/* ------------------------------------------------------------------ */

describe("shadow_snapshots — determinism", () => {
  test("HELL-E14: same input + same fake odb data ⇒ byte-identical output", async () => {
    const data: SnapshotMetadata[] = [snap(3), snap(2), snap(1)]
    const odb1 = fakeOdb({ listSnapshots: async () => data })
    const odb2 = fakeOdb({ listSnapshots: async () => data })
    const r1 = await collect(shadowSnapshotsTool(odb1), {})
    const r2 = await collect(shadowSnapshotsTool(odb2), {})
    expect(r1.output).toBe(r2.output)
    expect(r1.ok).toBe(r2.ok)
  })
})
