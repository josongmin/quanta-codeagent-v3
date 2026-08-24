/**
 * Characterization tests for `atomicFileWriteStrategy`'s PHASE CONTRACT —
 * added alongside the god-function split of `applyBatch` (44 → under cap).
 *
 * These pin the rules a decomposition could quietly break and that the
 * existing `lsp-atomic-write-hellgate` suite did NOT catch (verified by
 * injection: inverting the phase-A reason attribution, and dropping the
 * `commitFailed = true` on a mid-commit abort, both left that suite GREEN).
 *
 * Rules pinned here:
 *   R1  Phase A writes EVERY temp before Phase B renames ANY original.
 *   R2  On a phase-A failure the FAILING entry carries its own reason and
 *       every other entry carries the generic prior-entry reason — the two
 *       sides of the failing index are NOT distinguishable from each other.
 *   R3  A mid-commit abort is terminal: the aborted entry AND every entry
 *       after it fail, and their temps are LEFT ON DISK for recovery.
 *   R4  The EXDEV fallback copies BEFORE it unlinks (unlink-first would
 *       destroy the only good copy if the copy then failed).
 */
import { describe, expect, test } from "bun:test"
import { atomicFileWriteStrategy } from "@/lsp/adapters/file-write-atomic"
import type { FileWriteBatch, FileWriteFs } from "@/lsp/adapters/file-write-strategy"

type Op = { op: string; a: string; b?: string }

const exdev = (): Error => Object.assign(new Error("EXDEV"), { code: "EXDEV" })

/** FS shim that records an ORDERED op log and can fail a chosen op/path pair. */
const recordingFs = (
  ops: Op[],
  fail: (op: string, path: string) => Error | undefined = () => undefined,
): FileWriteFs => ({
  write: async (path, content) => {
    ops.push({ op: "write", a: path, b: content })
    const e = fail("write", path)
    if (e) throw e
    return 0
  },
  rename: async (from, to) => {
    ops.push({ op: "rename", a: from, b: to })
    const e = fail("rename", to)
    if (e) throw e
  },
  copyFile: async (from, to) => {
    ops.push({ op: "copyFile", a: from, b: to })
    const e = fail("copyFile", to)
    if (e) throw e
  },
  unlink: async (path) => {
    ops.push({ op: "unlink", a: path })
    const e = fail("unlink", path)
    if (e) throw e
  },
  listDir: async () => [],
})

const seqRand = (): (() => Uint8Array) => {
  let n = 0
  return () => {
    n += 1
    return new Uint8Array([0, 0, 0, 0, 0, 0, 0, n])
  }
}

const batch = (n: number): FileWriteBatch[] =>
  Array.from({ length: n }, (_, i) => ({ path: `/w/f${i}.ts`, content: `c${i}` }))

const strategy = (fs: FileWriteFs) => atomicFileWriteStrategy({ fs, randomBytes: seqRand() })

describe("atomic file write — phase ordering contract", () => {
  test("R1: every temp is written before any original is renamed", async () => {
    const ops: Op[] = []
    await strategy(recordingFs(ops)).applyBatch(batch(3))
    const lastWrite = ops.map((o) => o.op).lastIndexOf("write")
    const firstRename = ops.map((o) => o.op).indexOf("rename")
    expect(lastWrite).toBeGreaterThanOrEqual(0)
    expect(firstRename).toBeGreaterThanOrEqual(0)
    // The rule, not the shape: NO rename may precede the final temp write.
    expect(firstRename).toBeGreaterThan(lastWrite)
    // ...and no original path is ever a `write` target in phase A.
    for (const o of ops.filter((x) => x.op === "write"))
      expect(o.a).not.toBe(o.a.replace(/\.quanta-tmp-[0-9a-f]+$/, ""))
  })

  test("R1: a phase-A failure means NO rename and NO original touched at all", async () => {
    const ops: Op[] = []
    const fs = recordingFs(ops, (op, p) =>
      op === "write" && p.includes("f2.ts") ? new Error("ENOSPC") : undefined,
    )
    const out = await strategy(fs).applyBatch(batch(4))
    expect(ops.some((o) => o.op === "rename")).toBe(false)
    expect(ops.some((o) => o.op === "copyFile")).toBe(false)
    expect(out.every((o) => o.kind === "failed")).toBe(true)
    // Both temps written before the failure are rolled back.
    expect(ops.filter((o) => o.op === "unlink")).toHaveLength(2)
  })
})

describe("atomic file write — failure attribution contract", () => {
  test.each([
    0, 1, 2, 3,
  ])("R2: with phase-A failing at index %i, ONLY that index carries its own reason", async (failIdx) => {
    const ops: Op[] = []
    const fs = recordingFs(ops, (op, p) =>
      op === "write" && p.includes(`f${failIdx}.ts`) ? new Error(`BOOM-${failIdx}`) : undefined,
    )
    const out = await strategy(fs).applyBatch(batch(4))
    out.forEach((o, i) => {
      expect(o.kind).toBe("failed")
      const reason = o.kind === "failed" ? o.reason : ""
      if (i === failIdx) expect(reason).toBe(`BOOM-${failIdx}`)
      else expect(reason).toBe("aborted: prior entry failed")
    })
    // The generic reason must be the SAME on both sides of the failing index
    // (they used to be two separately-written branches).
    const before = out[0]
    const after = out[3]
    if (failIdx !== 0 && failIdx !== 3 && before?.kind === "failed" && after?.kind === "failed")
      expect(before.reason).toBe(after.reason)
  })

  test("R3: a mid-commit abort is terminal — later entries fail and temps survive", async () => {
    const ops: Op[] = []
    const ac = new AbortController()
    let renames = 0
    const fs: FileWriteFs = {
      ...recordingFs(ops),
      rename: async (from, to) => {
        ops.push({ op: "rename", a: from, b: to })
        renames += 1
        if (renames === 1) ac.abort() // abort AFTER the first commit lands
      },
    }
    const out = await strategy(fs).applyBatch(batch(3), ac.signal)
    expect(out[0]?.kind).toBe("ok")
    expect(out[1]).toEqual({
      kind: "failed",
      path: "/w/f1.ts",
      reason: "aborted: signal raised mid-commit (temp file remains for recovery)",
    })
    // Terminal: entry 2 is NOT retried, it inherits the prior-commit reason.
    expect(out[2]).toEqual({
      kind: "failed",
      path: "/w/f2.ts",
      reason: "aborted: prior commit failed (temp file remains for recovery)",
    })
    // Exactly one rename attempted; the surviving temps are NOT cleaned up.
    expect(ops.filter((o) => o.op === "rename")).toHaveLength(1)
    expect(ops.filter((o) => o.op === "unlink")).toHaveLength(0)
  })

  test("R3: a mid-commit plain rename failure is terminal in the same way", async () => {
    const ops: Op[] = []
    const fs = recordingFs(ops, (op, p) =>
      op === "rename" && p === "/w/f1.ts" ? new Error("EPERM") : undefined,
    )
    const out = await strategy(fs).applyBatch(batch(3))
    expect(out[0]?.kind).toBe("ok")
    expect(out[1]).toEqual({ kind: "failed", path: "/w/f1.ts", reason: "EPERM" })
    expect(out[2]?.kind).toBe("failed")
    expect(ops.filter((o) => o.op === "rename")).toHaveLength(2) // f2 never attempted
    expect(ops.filter((o) => o.op === "unlink")).toHaveLength(0) // temps preserved
  })
})

describe("atomic file write — EXDEV fallback ordering", () => {
  test("R4: copyFile precedes unlink, and the outcome carries the degradation warning", async () => {
    const ops: Op[] = []
    const fs = recordingFs(ops, (op, p) =>
      op === "rename" && p === "/w/f0.ts" ? exdev() : undefined,
    )
    const out = await strategy(fs).applyBatch(batch(1))
    const seq = ops.map((o) => o.op)
    expect(seq).toEqual(["write", "rename", "copyFile", "unlink"])
    expect(seq.indexOf("copyFile")).toBeLessThan(seq.indexOf("unlink"))
    const o0 = out[0]
    expect(o0?.kind).toBe("ok")
    expect(o0?.kind === "ok" ? o0.warning : undefined).toContain("non-atomic-fallback")
  })

  test("R4: a failing copy does NOT unlink the temp and stops the batch", async () => {
    const ops: Op[] = []
    const fs = recordingFs(ops, (op, p) => {
      if (op === "rename" && p === "/w/f0.ts") return exdev()
      if (op === "copyFile" && p === "/w/f0.ts") return new Error("EIO")
      return undefined
    })
    const out = await strategy(fs).applyBatch(batch(2))
    expect(ops.filter((o) => o.op === "unlink")).toHaveLength(0)
    expect(out[0]?.kind === "failed" ? out[0].reason : "").toContain(
      "EXDEV cross-fs rename + copyFile fallback failed: EIO",
    )
    expect(out[1]?.kind === "failed" ? out[1].reason : "").toContain("prior commit failed")
  })

  test("paired control: a non-EXDEV error must NOT take the copy fallback", async () => {
    const ops: Op[] = []
    const fs = recordingFs(ops, (op, p) =>
      op === "rename" && p === "/w/f0.ts" ? new Error("EPERM") : undefined,
    )
    const out = await strategy(fs).applyBatch(batch(1))
    expect(ops.some((o) => o.op === "copyFile")).toBe(false)
    expect(out[0]).toEqual({ kind: "failed", path: "/w/f0.ts", reason: "EPERM" })
  })
})
