/**
 * Hellgate: same-generation denial MERGE must NOT fabricate a complete
 * override sequence by folding HALF-sequences from two different processes
 * (ADR-0046 §Risks — the recordRiskSeen-BEFORE-recordUserOverride pairing
 * must come from ONE complete sequence).
 *
 * THE BYPASS (pre-fix): mergeDenialRecord took max(seenRiskAt) and
 * max(userOverrideAt) INDEPENDENTLY across the two records. So if:
 *   - process A recorded ONLY riskSeen@150  → {deniedAt:100, seenRiskAt:150}
 *   - process B recorded ONLY userOverride@200 → {deniedAt:100, userOverrideAt:200}
 * the merge produced {deniedAt:100, seenRiskAt:150, userOverrideAt:200}, a
 * coherent-looking complete sequence that NEITHER process ever completed.
 * `hasPostDenialOverride` then returned TRUE and policy.ts granted a
 * previously-DENIED mutating action.
 *
 * THE FIX (fail-closed): the override pair (seenRiskAt, userOverrideAt) is
 * carried as an ATOMIC unit from a SINGLE side whose progress is coherent.
 * A partial/incoherent fold yields hasPostDenialOverride=FALSE.
 *
 * ANTI-THEATER: against the unfixed `maxOpt`-of-each-field code this test's
 * first assertion (hasPostDenialOverride === false) FAILS — the old code would
 * have produced the fabricated complete sequence and returned true.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { computeActionSignature, createPermissionStore } from "@/permission"

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "quanta-perm-partialfold-"))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe("permission-store — partial-fold denial bypass (hellgate)", () => {
  test("two-process HALF-sequences (seen-only ⊎ override-only) DO NOT fabricate an override", async () => {
    const filePath = join(tmp, "partial-fold.json")
    const sig = computeActionSignature({ tool: "edit", workdir: "/repo", args: { path: "secret" } })
    const key = `t1::${sig}`
    const DENIED_AT = 100

    // --- Process A: denial + risk-seen ONLY (no user override). -------------
    const a = createPermissionStore({ filePath, debounceMs: 0 })
    await a.load()
    a.recordDenial({ threadId: "t1", actionSignature: sig, deniedAt: DENIED_AT, deniedReason: "x" })
    a.recordRiskSeen("t1", sig, 150)
    await a.flush()
    // Sanity: A alone is NOT a complete override (no user-override step).
    expect(a.hasPostDenialOverride("t1", sig)).toBe(false)

    // --- Craft the on-disk peer record: SAME generation (deniedAt=100), but
    //     userOverride ONLY (no risk-seen step). This is the other half of the
    //     sequence, written by a hypothetical process B. We plant it directly
    //     because the public API enforces seen-before-override, so no single
    //     legitimate process could ever produce this shape on its own. --------
    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number
      perThread: Record<string, unknown>
      perHost: Record<string, unknown>
      deniedActions: Record<
        string,
        {
          threadId: string
          actionSignature: string
          deniedAt: number
          deniedReason: string
          seenRiskAt?: number
          userOverrideAt?: number
        }
      >
    }
    onDisk.deniedActions[key] = {
      threadId: "t1",
      actionSignature: sig,
      deniedAt: DENIED_AT, // same generation as A
      deniedReason: "x",
      userOverrideAt: 200, // override WITHOUT a seen step (the other half)
    }
    await writeFile(filePath, JSON.stringify(onDisk, null, 2), "utf8")

    // --- A flushes again. The flush path re-reads disk and merges. The bug:
    //     independent max(seen)=150 (from A) + max(override)=200 (from disk)
    //     ⇒ {100,150,200} ⇒ hasPostDenialOverride=true. The fix: the override
    //     pair is carried atomically from ONE coherent side, so the fabricated
    //     sequence is rejected. -------------------------------------------------
    a.recordRiskSeen("t1", sig, 150) // no-op-ish mutation to force a re-merge flush
    await a.flush()

    // PRIMARY ASSERTION (fails against unfixed code): the fold MUST NOT grant.
    expect(a.hasPostDenialOverride("t1", sig)).toBe(false)

    // The persisted record must NOT contain BOTH halves stitched together.
    const merged = JSON.parse(await readFile(filePath, "utf8")) as {
      deniedActions: Record<string, { seenRiskAt?: number; userOverrideAt?: number }>
    }
    const rec = merged.deniedActions[key]
    expect(rec).toBeDefined()
    // A's side (rank 1: coherent risk-seen) wins atomically over disk's
    // incoherent override-only (rank 0): keep seenRiskAt, DROP the orphan override.
    expect(rec?.seenRiskAt).toBe(150)
    expect(rec?.userOverrideAt).toBeUndefined()
  })

  test("a coherent complete override from a SINGLE side still merges through (no over-restriction)", async () => {
    // Guard against the fix being too aggressive: when ONE side actually
    // completed a coherent sequence, the merge must still surface it.
    const filePath = join(tmp, "single-side-complete.json")
    const sig = computeActionSignature({ tool: "edit", workdir: "/repo", args: { path: "ok" } })
    const key = `t1::${sig}`

    const a = createPermissionStore({ filePath, debounceMs: 0 })
    await a.load()
    a.recordDenial({ threadId: "t1", actionSignature: sig, deniedAt: 100, deniedReason: "x" })
    a.recordRiskSeen("t1", sig, 110)
    a.recordUserOverride("t1", sig, 120)
    await a.flush()

    // Plant a same-generation peer that only got as far as risk-seen (rank 1).
    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as {
      deniedActions: Record<
        string,
        {
          threadId: string
          actionSignature: string
          deniedAt: number
          deniedReason: string
          seenRiskAt?: number
        }
      >
    }
    onDisk.deniedActions[key] = {
      threadId: "t1",
      actionSignature: sig,
      deniedAt: 100,
      deniedReason: "x",
      seenRiskAt: 105,
    }
    await writeFile(filePath, JSON.stringify(onDisk, null, 2), "utf8")

    // Force a re-merge. A's complete (rank 2) coherent record must win.
    a.recordRiskSeen("t1", sig, 110)
    await a.flush()

    expect(a.hasPostDenialOverride("t1", sig)).toBe(true)
    const merged = JSON.parse(await readFile(filePath, "utf8")) as {
      deniedActions: Record<string, { seenRiskAt?: number; userOverrideAt?: number }>
    }
    expect(merged.deniedActions[key]?.seenRiskAt).toBe(110)
    expect(merged.deniedActions[key]?.userOverrideAt).toBe(120)
  })
})
