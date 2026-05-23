/**
 * Hellgate — shadow_rewind `target` extension + new shadow_restore_partial
 * tool (ADR-0122).
 *
 * 10 cases pinning:
 *   A. shadow_rewind target=verified routing (4)
 *   B. shadow_restore_partial behavior (6)
 */

import { describe, expect, test } from "bun:test"
import { type ShadowOdb, ShadowOdbError } from "@/storage"
import { shadowRestorePartialTool, shadowRewindTool } from "@/tool/shadow"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

interface RewindCall {
  readonly kind: "last" | "verified"
  readonly workspaceRoot: string
  readonly opts: Readonly<Record<string, unknown>> | undefined
}

interface RestoreCall {
  readonly workspaceRoot: string
  readonly paths: readonly string[]
  readonly opts: Readonly<Record<string, unknown>> | undefined
}

interface FakeOdb extends ShadowOdb {
  readonly rewindCalls: RewindCall[]
  readonly restoreCalls: RestoreCall[]
}

const fakeOdb = (overrides?: Partial<ShadowOdb>): FakeOdb => {
  const rewindCalls: RewindCall[] = []
  const restoreCalls: RestoreCall[] = []
  const base: ShadowOdb = {
    init: async () => ({ shadowDir: "/tmp/x", workspaceHash: "abc" }),
    registerHead: async () => "sha-1",
    diffSinceLast: async () => "",
    diffWorkspaceSinceLast: async () => "",
    rewindToLast: async () => {},
    restorePartial: async () => {},
    markVerified: async () => {},
    rewindToVerified: async () => {},
    listSnapshots: async () => [],
    cleanup: async () => 0,
  }
  const merged: ShadowOdb = { ...base, ...(overrides ?? {}) }
  // Wrap rewindToLast + rewindToVerified + restorePartial to record
  // calls — the wrappers are the SSOT for call-recording so tests never
  // double-count when they supply their own override.
  const finalRewindLast = merged.rewindToLast
  merged.rewindToLast = async (workspaceRoot, opts) => {
    rewindCalls.push({
      kind: "last",
      workspaceRoot,
      opts: opts === undefined ? undefined : { ...opts },
    })
    return finalRewindLast(workspaceRoot, opts)
  }
  const finalRewindVerified = merged.rewindToVerified
  merged.rewindToVerified = async (workspaceRoot, opts) => {
    rewindCalls.push({
      kind: "verified",
      workspaceRoot,
      opts: opts === undefined ? undefined : { ...opts },
    })
    return finalRewindVerified(workspaceRoot, opts)
  }
  const finalRestore = merged.restorePartial
  merged.restorePartial = async (workspaceRoot, paths, opts) => {
    restoreCalls.push({
      workspaceRoot,
      paths: [...paths],
      opts: opts === undefined ? undefined : { ...opts },
    })
    return finalRestore(workspaceRoot, paths, opts)
  }
  return Object.assign(merged, { rewindCalls, restoreCalls }) as FakeOdb
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

/* ================================================================== */
/* A. shadow_rewind target routing (HELL-A1..A4)                       */
/* ================================================================== */

describe("shadow_rewind — target routing", () => {
  test("HELL-A1: target absent ⇒ routes to rewindToLast (back-compat)", async () => {
    const odb = fakeOdb()
    const t = shadowRewindTool(odb)
    const r = await collect(t, {})
    expect(r.ok).toBe(true)
    expect(odb.rewindCalls).toHaveLength(1)
    expect(odb.rewindCalls[0]?.kind).toBe("last")
  })

  test("HELL-A2: target='last' ⇒ routes to rewindToLast", async () => {
    const odb = fakeOdb()
    const t = shadowRewindTool(odb)
    const r = await collect(t, { target: "last" })
    expect(r.ok).toBe(true)
    expect(odb.rewindCalls).toHaveLength(1)
    expect(odb.rewindCalls[0]?.kind).toBe("last")
  })

  test("HELL-A3: target='verified' ⇒ routes to rewindToVerified + success output mentions 'verified'", async () => {
    const odb = fakeOdb()
    const t = shadowRewindTool(odb)
    const r = await collect(t, { target: "verified" })
    expect(r.ok).toBe(true)
    expect(odb.rewindCalls).toHaveLength(1)
    expect(odb.rewindCalls[0]?.kind).toBe("verified")
    expect(r.output).toContain("verified")
  })

  test("HELL-A4: target='verified' with no markVerified anchor ⇒ ok:false 'no-verified-anchor: ...'", async () => {
    const odb = fakeOdb({
      rewindToVerified: async () => {
        throw new ShadowOdbError("no-verified-anchor", "no markVerified yet")
      },
    })
    const t = shadowRewindTool(odb)
    const r = await collect(t, { target: "verified" })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("no-verified-anchor:")).toBe(true)
  })
})

/* ================================================================== */
/* B. shadow_restore_partial (HELL-B5..B10)                            */
/* ================================================================== */

describe("shadow_restore_partial — schema + routing + metadata", () => {
  test("HELL-B5: paths=[] ⇒ ok:false 'invalid input: ...' (zod min(1))", async () => {
    const odb = fakeOdb()
    const t = shadowRestorePartialTool(odb)
    const r = await collect(t, { paths: [] })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/^invalid input:/)
    expect(odb.restoreCalls).toHaveLength(0)
  })

  test("HELL-B6: paths=['a.ts'] ⇒ odb.restorePartial called with paths + default target=last", async () => {
    const odb = fakeOdb()
    const t = shadowRestorePartialTool(odb)
    const r = await collect(t, { paths: ["a.ts"] })
    expect(r.ok).toBe(true)
    expect(odb.restoreCalls).toHaveLength(1)
    expect(odb.restoreCalls[0]?.paths).toEqual(["a.ts"])
    // exact-optional spread — no allowDirtyMerge key when input omitted it.
    expect("allowDirtyMerge" in (odb.restoreCalls[0]?.opts ?? {})).toBe(false)
  })

  test("HELL-B7: target='verified' (v1) ⇒ ok:false 'no-verified-anchor: ...' (partial-verified deferred)", async () => {
    const odb = fakeOdb()
    const t = shadowRestorePartialTool(odb)
    const r = await collect(t, { paths: ["a.ts"], target: "verified" })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("no-verified-anchor:")).toBe(true)
    // Port NOT called for verified target in v1 — surface is a tool-level
    // typed error so the user-facing code shape matches rewindToVerified.
    expect(odb.restoreCalls).toHaveLength(0)
  })

  test("HELL-B8: absolute path in paths ⇒ ok:false 'rewind-failed: ...' (port-level path safety)", async () => {
    // The port's `assertRepoRelativePaths` throws `rewind-failed` on
    // absolute paths. The hand-rolled fake's `restorePartial` no-ops by
    // default — to exercise the tool's typed-error mapping path we
    // override it to throw the same code the real port would.
    const odb = fakeOdb({
      restorePartial: async (_ws, paths) => {
        for (const p of paths) {
          if (p.startsWith("/")) {
            throw new ShadowOdbError(
              "rewind-failed",
              `restorePartial rejected absolute path: ${JSON.stringify(p)}`,
            )
          }
        }
      },
    })
    const t = shadowRestorePartialTool(odb)
    const r = await collect(t, { paths: ["/etc/passwd"] })
    expect(r.ok).toBe(false)
    // Port rejects via assertRepoRelativePaths ⇒ rewind-failed code.
    expect(r.output.startsWith("rewind-failed:")).toBe(true)
  })

  test("HELL-B9: hitlTier() === 'always-confirm' (destructive-by-name)", () => {
    const odb = fakeOdb()
    const t = shadowRestorePartialTool(odb)
    expect(t.hitlTier?.({ paths: ["a.ts"] })).toBe("always-confirm")
    expect(t.isReadOnly()).toBe(false)
    expect(t.isConcurrencySafe({ paths: ["a.ts"] })).toBe(false)
  })

  test("HELL-B10: output includes 'Restored 1 file from last: a.ts' (singular + file list)", async () => {
    const odb = fakeOdb()
    const t = shadowRestorePartialTool(odb)
    const r = await collect(t, { paths: ["a.ts"] })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Restored 1 file from last: a.ts")
  })
})
