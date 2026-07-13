/** jul-13 hellgate — apply_patch × edit-fresh-hash STALE-READ BASELINE REFRESH
 *  under the DEFAULT-ON mtime stale-read guard (ADR-0474).
 *
 *  WHY THIS FILE EXISTS: the edit-fresh-hash feature (DEFAULT-ON, opt-out
 *  `QUANTA_EDIT_FRESH_HASH=off`) refreshes the stale-read guard baseline after a
 *  successful mutation so a CHAINED (no-re-read) edit survives the DEFAULT-ON
 *  mtime guard. `tests/unit/edit-fresh-hash-mtime-interaction-hellgate.test.ts`
 *  pins this for the single-flat-file tools (edit/write/scripted_replace), which
 *  ALSO emit a `fresh sha256: <hex>` manifest. This file pins the MULTI-FILE
 *  `apply_patch` sibling: `refreshApplyBaselines` in `src/tool/apply-patch.ts`
 *  re-stats each ADDED/UPDATED/MOVED-to file POST-commit and records the new
 *  mtime via the shared `recordFreshBaseline` — but deliberately does NOT emit a
 *  fresh-hash (apply_patch does not retain per-file bytes, so hashing would need
 *  N re-reads, defeating the zero-standing-cost invariant).
 *
 *  THE DEFEAT (was real, now cured for apply_patch): `read` records a file's
 *  read-time mtime. `edit`'s pre-commit guard (`guardWrite`, strict `>` on mtime)
 *  REJECTS with `stale_read` when the on-disk mtime advanced past the recorded
 *  value. A successful `apply_patch` UPDATES a file and advances its mtime — so a
 *  CHAINED `edit` to that same file that (by design) skips the re-read hit
 *  `stale_read`. `refreshApplyBaselines` (gated by `ctx.editFreshHash`) re-records
 *  each touched file's post-commit mtime, so the chained edit is fresh.
 *
 *  WHAT THIS FILE PINS (all against a REAL tmpdir fs with a REAL ReadFileState
 *  wired exactly as production wires it — Home-bonus ZERO, mutation-resistant):
 *    1. CORE GAP-CLOSE  — read-record → apply_patch UPDATES → chained edit (no
 *                         re-read, content-match old_string) SUCCEEDS (no stale_read).
 *    2. MULTI-FILE      — a patch touching update-A + add-B → a chained edit to
 *                         EACH survives (both baselines refreshed).
 *    3. ADD + MOVE      — an ADDED file and a MOVED-to file each get the baseline
 *                         recorded == the post-commit on-disk mtime; chained edits
 *                         to them are not spuriously stale.
 *    4. GATING (PAIRED CONTROL) — with editFreshHash ABSENT, apply_patch does NOT
 *                         refresh ⇒ a chained no-re-read edit FAILS stale_read.
 *                         Test 1 succeeds ONLY because of the refresh (test 1 vs 4
 *                         isolates the refresh as the cause — non-vacuity by design).
 *    5. NO EMISSION     — apply_patch's success output contains NO `fresh sha256`
 *                         substring (deliberate multi-file scope decision).
 *    6. SAFETY          — an EXTERNAL modification after the patch STILL trips
 *                         stale_read on a chained edit: the refresh did NOT neuter
 *                         the guard's TOCTOU protection.
 *
 *  This file does NOT touch any existing test file or any src file. */

import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultFileSystemPort } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { applyPatchTool } from "@/tool/apply-patch"
import { makeEditTool } from "@/tool/edit"
import { ReadFileState } from "@/tool/stale-read-guard"

const FRESH_RE = /fresh sha256: [0-9a-f]{64}/

/** Production-faithful ToolContext: DEFAULT-ON stale-read guard (a live
 *  `ReadFileState`) AND `editFreshHash` on — exactly what a default session mints.
 *  Omitting `editFreshHash` models `QUANTA_EDIT_FRESH_HASH=off` (ctx.editFreshHash
 *  absent) — the gating paired control. */
const prodCtx = (
  cwd: string,
  readFileState: ReadFileState | undefined,
  freshHash: boolean,
): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  ...(readFileState !== undefined ? { readFileState } : {}),
  ...(freshHash ? { editFreshHash: true } : {}),
})

/** Drive the REAL apply_patch generator end-to-end; capture the terminal result. */
const runApply = async (patch: string, ctx: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of applyPatchTool.execute({ patch } as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("apply_patch: no result")
  return result
}

/** Drive the REAL edit tool generator end-to-end; capture the terminal result. */
const runEdit = async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of makeEditTool(defaultFileSystemPort).execute(input as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("edit: no result")
  return result
}

/** Model the `read` tool's recording exactly: stat the file, record the RESOLVED
 *  absolute path + its mtimeMs (the read-time baseline the model "saw"). */
const recordReadTimeMtime = (state: ReadFileState, absPath: string): number => {
  const m = statSync(absPath).mtimeMs
  state.record(absPath, m)
  return m
}

/** V4A "*** Update File:" patch turning `gamma` → `GAMMA` in the standard body. */
const updatePatch = (relFile: string): string =>
  [
    "*** Begin Patch",
    `*** Update File: ${relFile}`,
    "@@",
    " beta",
    "-gamma",
    "+GAMMA",
    " delta",
    "*** End Patch",
  ].join("\n")

const ORIGINAL = "alpha\nbeta\ngamma\ndelta\nepsilon\n"
const PATCHED = "alpha\nbeta\nGAMMA\ndelta\nepsilon\n"

describe("jul-13 apply_patch × edit-fresh-hash baseline refresh — PRODUCTION TRUTH (real fs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "apply-fresh-hash-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("1. CORE GAP-CLOSE: read-record → apply_patch UPDATES → chained no-re-read edit SUCCEEDS (no stale_read)", async () => {
    // The EXACT production sequence the refresh promises: read once → apply_patch
    // updates the file (advancing its mtime) → edit the SAME file WITHOUT a re-read
    // using a content-match old_string, all under the DEFAULT-ON guard. Before the
    // refresh this edit was rejected `stale_read`. Reverting `refreshApplyBaselines`
    // flips this RED.
    const path = join(dir, "gap-close.txt")
    writeFileSync(path, ORIGINAL, "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const ctx = prodCtx(dir, state, true)

    const r1 = await runApply(updatePatch("gap-close.txt"), ctx)
    expect(r1.ok).toBe(true)
    expect(readFileSync(path, "utf8")).toBe(PATCHED)

    // The patch advanced the file's mtime AND refreshed the guard baseline to it.
    expect(state.recordedMtime(path)).toBe(statSync(path).mtimeMs)

    // Chained edit, NO re-read, content-match old_string on the patched bytes.
    const r2 = await runEdit({ path, old_string: "GAMMA", new_string: "GAMMA2" }, ctx)
    expect(r2.ok).toBe(true)
    expect(r2.failure).toBeUndefined()
    expect(readFileSync(path, "utf8")).toBe("alpha\nbeta\nGAMMA2\ndelta\nepsilon\n")
  })

  test("2. MULTI-FILE: patch updates A + adds B → a chained edit to EACH survives (both baselines refreshed)", async () => {
    const fileA = join(dir, "multi-a.txt")
    const fileB = join(dir, "multi-b.txt")
    writeFileSync(fileA, ORIGINAL, "utf8")
    // B does not exist yet — it is ADDED by the patch (no prior baseline).
    const state = new ReadFileState()
    recordReadTimeMtime(state, fileA)
    const ctx = prodCtx(dir, state, true)

    const patch = [
      "*** Begin Patch",
      "*** Update File: multi-a.txt",
      "@@",
      " beta",
      "-gamma",
      "+GAMMA",
      " delta",
      "*** Add File: multi-b.txt",
      "+brand new B",
      "*** End Patch",
    ].join("\n")

    const r1 = await runApply(patch, ctx)
    expect(r1.ok).toBe(true)
    expect(readFileSync(fileA, "utf8")).toBe(PATCHED)
    expect(readFileSync(fileB, "utf8")).toBe("brand new B")

    // Both touched files' baselines refreshed to their post-commit on-disk mtime.
    expect(state.recordedMtime(fileA)).toBe(statSync(fileA).mtimeMs)
    expect(state.recordedMtime(fileB)).toBe(statSync(fileB).mtimeMs)

    // A chained no-re-read edit to EACH survives the DEFAULT-ON guard.
    const rA = await runEdit({ path: fileA, old_string: "GAMMA", new_string: "GAMMA_A" }, ctx)
    expect(rA.ok).toBe(true)
    expect(rA.failure).toBeUndefined()

    const rB = await runEdit({ path: fileB, old_string: "brand new B", new_string: "edited B" }, ctx)
    expect(rB.ok).toBe(true)
    expect(rB.failure).toBeUndefined()
    expect(readFileSync(fileB, "utf8")).toBe("edited B")
  })

  test("3. ADD + MOVE coverage: an ADDED file and a MOVED-to file each get baseline == post-commit on-disk mtime", async () => {
    // MOVE source is read-recorded (the model read it to decide the move); the ADD
    // target has no prior baseline (naturally fresh). Both the added file AND the
    // move DESTINATION must end with a recorded baseline equal to their post-commit
    // on-disk mtime, so a chained edit to either is not spuriously stale.
    const moveSrc = join(dir, "move-src.txt")
    const moveDst = join(dir, "move-dst.txt")
    const added = join(dir, "added.txt")
    writeFileSync(moveSrc, ORIGINAL, "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, moveSrc) // read-record the move SOURCE
    const ctx = prodCtx(dir, state, true)

    const patch = [
      "*** Begin Patch",
      "*** Update File: move-src.txt",
      "*** Move to: move-dst.txt",
      "@@",
      " beta",
      "-gamma",
      "+GAMMA",
      " delta",
      "*** Add File: added.txt",
      "+fresh add",
      "*** End Patch",
    ].join("\n")

    const r1 = await runApply(patch, ctx)
    expect(r1.ok).toBe(true)
    expect(existsSync(moveSrc)).toBe(false) // moved away
    expect(readFileSync(moveDst, "utf8")).toBe(PATCHED)
    expect(readFileSync(added, "utf8")).toBe("fresh add")

    // The MOVED-to destination baseline == its post-commit on-disk mtime.
    expect(state.recordedMtime(moveDst)).toBe(statSync(moveDst).mtimeMs)
    // The ADDED file baseline == its post-commit on-disk mtime.
    expect(state.recordedMtime(added)).toBe(statSync(added).mtimeMs)

    // Chained edits to the moved-to file and the added file both survive the guard.
    const rMove = await runEdit({ path: moveDst, old_string: "GAMMA", new_string: "GAMMA_M" }, ctx)
    expect(rMove.ok).toBe(true)
    expect(rMove.failure).toBeUndefined()

    const rAdd = await runEdit({ path: added, old_string: "fresh add", new_string: "edited add" }, ctx)
    expect(rAdd.ok).toBe(true)
    expect(rAdd.failure).toBeUndefined()
  })

  test("4. GATING (PAIRED CONTROL): editFreshHash ABSENT ⇒ no refresh ⇒ chained no-re-read edit FAILS stale_read", async () => {
    // The mirror of test 1 with the ONLY difference being the flag off. apply_patch
    // does NOT refresh the baseline (byte-identical legacy), so the file's advanced
    // post-patch mtime is now > the read-time baseline the guard still holds — the
    // chained edit is rejected stale_read. This is the NON-VACUITY proof: test 1
    // succeeds ONLY because of the refresh this test's absence isolates.
    const path = join(dir, "gating-off.txt")
    writeFileSync(path, ORIGINAL, "utf8")
    const state = new ReadFileState()
    const readTimeMtime = recordReadTimeMtime(state, path)
    // Flag OFF ⇒ ctx.editFreshHash absent. The guard (readFileState) is still wired
    // exactly as production, isolating the refresh as the sole variable vs test 1.
    const ctx = prodCtx(dir, state, false)

    const r1 = await runApply(updatePatch("gating-off.txt"), ctx)
    expect(r1.ok).toBe(true)
    expect(readFileSync(path, "utf8")).toBe(PATCHED)

    // OFF ⇒ baseline untouched by the patch: still the pre-patch read-time mtime.
    expect(state.recordedMtime(path)).toBe(readTimeMtime)
    // And the patch advanced the on-disk mtime past that stale baseline.
    expect(statSync(path).mtimeMs).toBeGreaterThan(readTimeMtime)

    // The chained no-re-read edit is now vetoed stale_read (the defeat, un-cured).
    const r2 = await runEdit({ path, old_string: "GAMMA", new_string: "GAMMA2" }, ctx)
    expect(r2.ok).toBe(false)
    expect(r2.failure?.mode).toBe("rejected")
    expect((r2.failure as { reason?: string } | undefined)?.reason).toBe("stale_read")
    // The rejected edit never landed — the patched bytes are intact.
    expect(readFileSync(path, "utf8")).toBe(PATCHED)
  })

  test("5. NO EMISSION: apply_patch success output contains NO `fresh sha256` substring (deliberate multi-file scope)", async () => {
    // Unlike edit/write/scripted_replace, apply_patch does NOT emit a fresh-hash
    // manifest (it does not retain per-file bytes ⇒ hashing would need N re-reads).
    // The correctness refresh ships; emission is intentionally out of scope.
    const path = join(dir, "no-emit.txt")
    writeFileSync(path, ORIGINAL, "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const ctx = prodCtx(dir, state, true)

    const r = await runApply(updatePatch("no-emit.txt"), ctx)
    expect(r.ok).toBe(true)
    expect(r.output ?? "").not.toMatch(FRESH_RE)
    expect(r.output ?? "").not.toContain("fresh sha256")

    // Positive contrast: an `edit` to the SAME file under the SAME flag DOES emit,
    // proving the absence above is apply_patch-specific, not a flag-off artefact.
    const rEdit = await runEdit({ path, old_string: "GAMMA", new_string: "GAMMA3" }, ctx)
    expect(rEdit.ok).toBe(true)
    expect(rEdit.output ?? "").toMatch(FRESH_RE)
  })

  test("6. SAFETY: an EXTERNAL modification after apply_patch STILL trips stale_read on a chained edit (guard not neutered)", async () => {
    // The refresh records the patch's OWN post-commit mtime — it must NOT blind the
    // guard to a real external clobber. After the patch, an out-of-band writer
    // touches the file to a definitively-later mtime; a chained no-re-read edit must
    // be rejected stale_read, so the TOCTOU protection the guard exists for survives.
    const path = join(dir, "external-clobber.txt")
    writeFileSync(path, ORIGINAL, "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const ctx = prodCtx(dir, state, true)

    const r1 = await runApply(updatePatch("external-clobber.txt"), ctx)
    expect(r1.ok).toBe(true)
    // Refresh landed: baseline == post-commit on-disk mtime.
    expect(state.recordedMtime(path)).toBe(statSync(path).mtimeMs)

    // EXTERNAL clobber: force the mtime clearly AFTER what the patch recorded
    // (deterministic — not dependent on fs mtime granularity).
    const future = new Date(Date.now() + 60_000)
    utimesSync(path, future, future)
    expect(statSync(path).mtimeMs).toBeGreaterThan(state.recordedMtime(path) as number)

    // The guard still fires on the external change — the refresh did not disable TOCTOU.
    const r2 = await runEdit({ path, old_string: "GAMMA", new_string: "GAMMA2" }, ctx)
    expect(r2.ok).toBe(false)
    expect(r2.failure?.mode).toBe("rejected")
    expect((r2.failure as { reason?: string } | undefined)?.reason).toBe("stale_read")
    // The rejected edit never landed — the patched bytes are intact.
    expect(readFileSync(path, "utf8")).toBe(PATCHED)
  })
})
