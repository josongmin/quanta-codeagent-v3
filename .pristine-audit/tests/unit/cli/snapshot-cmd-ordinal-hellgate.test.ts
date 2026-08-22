/**
 * WS-D batch-1 (UUX-6-01/02/18) — `/snapshot <N>` effect-receipt hellgate.
 *
 * Template: **success text while the store/target is unchanged (or points at
 * the WRONG snapshot) ⇒ RED.** Every destructive/preview leg of `/snapshot`
 * must either (a) produce the REAL ordinal effect (worktree bytes equal the
 * addressed snapshot's content, observed by fresh readback from disk), or
 * (b) fail-closed with a nonzero exit — a success print for an unsupported /
 * mis-routed target must be unrepresentable.
 *
 * Strategy: REAL `defaultShadowOdb` + real `git` inside tmpdirs (same harness
 * posture as `tests/unit/shadow-odb-hellgate.test.ts`). Ordinals are derived
 * from `listSnapshots()` (exactly what the command itself renders), so the
 * assertions are immune to committerdate tie-ordering.
 *
 * Workspace timeline (three DISTINCT contents so wrong-target is detectable):
 *   1. f.txt = "v1"      → registerHead   (SHADOW_LAST_REF → v1)
 *   2. f.txt = "v2"      → rewindToLast   (pre-rewind ref captures v2; tree → v1)
 *   3. f.txt = "current" (uncommitted worktree)
 *
 * Target = the pre-rewind ref holding "v2". The legacy bug: `/snapshot <N>
 * --yes` always ran `rewindToLast` (tree → "v1") while printing
 * "rewound to #N" — success copy with the WRONG target effect.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { promises as fs, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SlashContext } from "@/apps/cli/slash-commands"
import { snapshotCmd } from "@/apps/cli/snapshot-cmd"
import {
  defaultShadowOdb,
  SHADOW_LAST_REF,
  SHADOW_LAST_VERIFIED_REF,
  type ShadowOdb,
  ShadowOdbError,
  type SnapshotMetadata,
} from "@/storage"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

let baseDir = ""
const cleanups: string[] = []

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), "snap-ordinal-base-"))
  cleanups.push(baseDir)
})
afterAll(() => {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true })
})

interface Ctx {
  readonly ctx: SlashContext
  readonly stdout: () => string
  readonly stderr: () => string
}

const makeCtx = (cwd: string, odb: ShadowOdb): Ctx => {
  let out = ""
  let err = ""
  const ctx = {
    out: (s: string) => {
      out += s
    },
    err: (s: string) => {
      err += s
    },
    cwd,
    shadowOdb: odb,
  } as SlashContext
  return { ctx, stdout: () => out, stderr: () => err }
}

interface Fixture {
  readonly ws: string
  readonly odb: ShadowOdb
  readonly snaps: readonly SnapshotMetadata[]
  /** 1-based ordinal of the pre-rewind ref that captured "v2". */
  readonly v2Ordinal: number
  /** 1-based ordinal of SHADOW_LAST_REF (content "v1"). */
  readonly lastOrdinal: number
}

const buildFixture = async (): Promise<Fixture> => {
  const ws = mkdtempSync(join(tmpdir(), "snap-ordinal-ws-"))
  cleanups.push(ws)
  const odb = defaultShadowOdb({ baseDir })
  const f = join(ws, "f.txt")
  await fs.writeFile(f, "v1", "utf8")
  await odb.registerHead(ws)
  await fs.writeFile(f, "v2", "utf8")
  await odb.rewindToLast(ws) // safety net captures "v2"; worktree back to "v1"
  await fs.writeFile(f, "current", "utf8")
  const snaps = await odb.listSnapshots(ws)
  const preRewind = snaps.findIndex((s) => s.ref.includes("pre-rewind-"))
  const last = snaps.findIndex((s) => s.ref === SHADOW_LAST_REF)
  if (preRewind < 0 || last < 0) throw new Error("fixture refs missing")
  return { ws, odb, snaps, v2Ordinal: preRewind + 1, lastOrdinal: last + 1 }
}

const readF = (ws: string): Promise<string> => fs.readFile(join(ws, "f.txt"), "utf8")

/* ------------------------------------------------------------------ */
/* hellgate — rewind leg                                               */
/* ------------------------------------------------------------------ */

describe("/snapshot <N> — ordinal rewind effect receipt", () => {
  test("HELLGATE: `/snapshot <N> --yes` for a non-last ordinal — real ordinal effect OR nonzero exit; success-print-with-wrong-target is unrepresentable", async () => {
    const fx = await buildFixture()
    const { ctx, stdout } = makeCtx(fx.ws, fx.odb)

    const exit = await snapshotCmd.run([String(fx.v2Ordinal), "--yes"], ctx)
    const content = await readF(fx.ws) // fresh readback from disk

    if (exit === 0) {
      // Success copy is only allowed when the ADDRESSED snapshot landed.
      expect(content).toBe("v2")
      // And the success line must reference the ordinal it actually restored.
      expect(stdout()).toContain(`#${fx.v2Ordinal}`)
    } else {
      // Fail-closed: nonzero exit AND the worktree untouched.
      expect(content).toBe("current")
    }
    // The RED clincher against the legacy bug: exit 0 + "v1" (rewindToLast
    // fired instead of the addressed ordinal) is the forbidden state.
    expect(exit === 0 && content !== "v2").toBe(false)
  })

  test("paired control: the SHADOW_LAST_REF ordinal still rewinds to last (v1)", async () => {
    const fx = await buildFixture()
    const { ctx } = makeCtx(fx.ws, fx.odb)
    const exit = await snapshotCmd.run([String(fx.lastOrdinal), "--yes"], ctx)
    expect(exit).toBe(0)
    expect(await readF(fx.ws)).toBe("v1")
  })

  test("out-of-range ordinal fails closed (nonzero exit, worktree untouched)", async () => {
    const fx = await buildFixture()
    const { ctx, stderr } = makeCtx(fx.ws, fx.odb)
    const exit = await snapshotCmd.run(["99", "--yes"], ctx)
    expect(exit).toBe(1)
    expect(stderr()).toContain("out of range")
    expect(await readF(fx.ws)).toBe("current")
  })

  test("confirm leg (no --yes) mutates NOTHING and exits 0", async () => {
    const fx = await buildFixture()
    const { ctx, stdout } = makeCtx(fx.ws, fx.odb)
    const exit = await snapshotCmd.run([String(fx.v2Ordinal)], ctx)
    expect(exit).toBe(0)
    expect(stdout()).toContain("--yes")
    expect(await readF(fx.ws)).toBe("current")
  })
})

/* ------------------------------------------------------------------ */
/* hellgate — verified-target × ordinal combo                          */
/* ------------------------------------------------------------------ */

describe("/snapshot --target=verified <N> — ordinal/verified coherence", () => {
  test("HELLGATE: verified target with an ordinal that is NOT the verified ref — nonzero exit, never a '#N' success print", async () => {
    const fx = await buildFixture()
    await fx.odb.markVerified(fx.ws) // verified anchor = v1 commit
    const { ctx } = makeCtx(fx.ws, fx.odb)
    // Re-list: markVerified added a ref, ordinals may have shifted.
    const snaps = await fx.odb.listSnapshots(fx.ws)
    const preIdx = snaps.findIndex((s) => s.ref.includes("pre-rewind-"))
    const verIdx = snaps.findIndex((s) => s.ref === SHADOW_LAST_VERIFIED_REF)
    expect(preIdx).toBeGreaterThanOrEqual(0)
    expect(verIdx).toBeGreaterThanOrEqual(0)

    // Ordinal addresses the pre-rewind ref, but --target=verified claims the
    // verified anchor: the two disagree — legacy code silently ran
    // rewindToVerified while printing "rewound to #N".
    const exit = await snapshotCmd.run([String(preIdx + 1), "--yes", "--target=verified"], ctx)
    const content = await readF(fx.ws)
    expect(exit).not.toBe(0)
    expect(content).toBe("current") // fail-closed: nothing moved
  })

  test("paired control: verified target with the verified ref's OWN ordinal rewinds to the verified content", async () => {
    const fx = await buildFixture()
    await fx.odb.markVerified(fx.ws)
    const { ctx } = makeCtx(fx.ws, fx.odb)
    const snaps = await fx.odb.listSnapshots(fx.ws)
    const verIdx = snaps.findIndex((s) => s.ref === SHADOW_LAST_VERIFIED_REF)
    const exit = await snapshotCmd.run([String(verIdx + 1), "--yes", "--target=verified"], ctx)
    expect(exit).toBe(0)
    expect(await readF(fx.ws)).toBe("v1")
  })
})

/* ------------------------------------------------------------------ */
/* hellgate — partial-restore leg                                      */
/* ------------------------------------------------------------------ */

describe("/snapshot <N> <file> — partial restore honors the ordinal", () => {
  test("HELLGATE: partial restore from a non-last ordinal — addressed content lands OR nonzero exit", async () => {
    const fx = await buildFixture()
    const { ctx } = makeCtx(fx.ws, fx.odb)
    const exit = await snapshotCmd.run([String(fx.v2Ordinal), "f.txt", "--yes"], ctx)
    const content = await readF(fx.ws)
    if (exit === 0) {
      expect(content).toBe("v2")
    } else {
      expect(content).toBe("current")
    }
    expect(exit === 0 && content !== "v2").toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* hellgate — diff leg                                                 */
/* ------------------------------------------------------------------ */

describe("/snapshot diff <N> — arbitrary-ordinal preview", () => {
  test("HELLGATE: diff against a non-#1 ordinal shows a REAL diff vs that snapshot OR exits nonzero — never a 0-exit 'unsupported' shrug", async () => {
    const fx = await buildFixture()
    const { ctx, stdout } = makeCtx(fx.ws, fx.odb)
    const exit = await snapshotCmd.run(["diff", String(fx.v2Ordinal)], ctx)
    if (exit === 0) {
      // worktree "current" vs snapshot "v2" — both sides must appear.
      expect(stdout()).toContain("v2")
      expect(stdout()).toContain("current")
    } else {
      expect(exit).not.toBe(0)
    }
    // Forbidden state: exit 0 with no actual diff content for the target.
    expect(exit === 0 && !stdout().includes("v2")).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* direct port-impl contract (real ODB, no CLI in between)             */
/* ------------------------------------------------------------------ */

describe("ShadowOdb ordinal ops — direct impl contract", () => {
  test("rewindToRef restores the addressed snapshot's bytes, mints a safety-net ref, and returns the receipt", async () => {
    const fx = await buildFixture()
    const before = await fx.odb.listSnapshots(fx.ws)
    const target = fx.snaps[fx.v2Ordinal - 1] as SnapshotMetadata

    const receipt = await fx.odb.rewindToRef(fx.ws, fx.v2Ordinal, { expectSha: target.sha })

    expect(receipt.sha).toBe(target.sha)
    expect(receipt.ref).toBe(target.ref)
    expect(await readF(fx.ws)).toBe("v2")
    // Safety net: the pre-restore worktree ("current") got its own new ref.
    const after = await fx.odb.listSnapshots(fx.ws)
    expect(after.length).toBe(before.length + 1)
  })

  test("expectSha mismatch fails closed with typed `snapshot-moved` and mutates NOTHING", async () => {
    const fx = await buildFixture()
    let caught: unknown
    try {
      await fx.odb.rewindToRef(fx.ws, fx.v2Ordinal, { expectSha: "f".repeat(40) })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ShadowOdbError)
    expect((caught as ShadowOdbError).code).toBe("snapshot-moved")
    expect(await readF(fx.ws)).toBe("current") // worktree untouched
    // No safety-net ref was minted for the refused op.
    expect((await fx.odb.listSnapshots(fx.ws)).length).toBe(fx.snaps.length)
  })

  test("ordinal out of range fails closed with typed `ordinal-out-of-range` (rewind + partial + diff)", async () => {
    const fx = await buildFixture()
    const codes: string[] = []
    for (const attempt of [
      () => fx.odb.rewindToRef(fx.ws, 99),
      () => fx.odb.restorePartialFromRef(fx.ws, 99, ["f.txt"]),
      () => fx.odb.diffSinceRef(fx.ws, 99),
    ]) {
      try {
        await attempt()
        codes.push("NO-THROW")
      } catch (e) {
        codes.push(e instanceof ShadowOdbError ? e.code : "WRONG-TYPE")
      }
    }
    expect(codes).toEqual(["ordinal-out-of-range", "ordinal-out-of-range", "ordinal-out-of-range"])
    expect(await readF(fx.ws)).toBe("current")
  })

  test("restorePartialFromRef with an empty path list is a typed refusal (no fabricated receipt)", async () => {
    const fx = await buildFixture()
    let caught: unknown
    try {
      await fx.odb.restorePartialFromRef(fx.ws, fx.v2Ordinal, [])
    } catch (e) {
      caught = e
    }
    expect((caught as ShadowOdbError).code).toBe("rewind-failed")
  })

  test("diffSinceRef returns the resolved snapshot + a real diff against it", async () => {
    const fx = await buildFixture()
    const { snap, diff } = await fx.odb.diffSinceRef(fx.ws, fx.v2Ordinal)
    expect(snap.sha).toBe((fx.snaps[fx.v2Ordinal - 1] as SnapshotMetadata).sha)
    expect(diff).toContain("-v2")
    expect(diff).toContain("+current")
  })
})
