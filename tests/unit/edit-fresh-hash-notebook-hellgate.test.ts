/** jul-13 hellgate — notebook_edit × edit-fresh-hash STALE-READ BASELINE REFRESH
 *  under the DEFAULT-ON mtime stale-read guard (ADR-0474).
 *
 *  WHY THIS FILE EXISTS: `notebook_edit` MUTATES a `.ipynb` file (writes back the
 *  edited nbformat JSON) and runs the SAME DEFAULT-ON mtime stale-read guard
 *  (`guardWrite`, strict `>` on mtime, keyed by resolved path) that `edit`/`write`
 *  use. But — unlike edit/write — it was MISSING the post-write baseline refresh.
 *  So a CHAINED (no-re-read) notebook_edit/edit to the SAME file was falsely
 *  vetoed `stale_read`, because the notebook write advanced the file's on-disk
 *  mtime past the read-time baseline the guard still held.
 *
 *  THE FIX (was real, now cured): `src/tool/notebook-edit/tool.ts` now calls
 *  `refreshStaleReadBaseline(fs, ctx, { path, base: ctx.cwd })` after a SUCCESSFUL
 *  write (before the success yield). It re-stats the just-written notebook and
 *  re-records its post-commit mtime via the shared `recordFreshBaseline`, so a
 *  chained edit is fresh. It is REFRESH-ONLY: notebook_edit is CELL-OP based and
 *  does NOT consume/emit `expected_hash`, so — like apply_patch — it deliberately
 *  emits NO `fresh sha256` manifest. Gated by `ctx.editFreshHash` (DEFAULT-ON,
 *  opt-out `QUANTA_EDIT_FRESH_HASH=off`) ⇒ byte-identical when off.
 *
 *  WHAT THIS FILE PINS (all against a REAL tmpdir fs with a REAL ReadFileState
 *  wired exactly as production wires it — Home-bonus ZERO, mutation-resistant):
 *    1. CORE GAP-CLOSE — read-record a VALID .ipynb → notebook_edit str_replace a
 *                        cell (advances mtime) → baseline == on-disk mtime (refresh
 *                        landed) → a chained no-re-read edit to the SAME file
 *                        SUCCEEDS (no stale_read). Before the fix: stale_read RED.
 *    2. GATING (PAIRED CONTROL) — with editFreshHash ABSENT, notebook_edit does
 *                        NOT refresh ⇒ the chained no-re-read edit FAILS
 *                        `{mode:"rejected", reason:"stale_read"}`. This isolates
 *                        the refresh as the sole cure (test 1 succeeds ONLY because
 *                        of it — non-vacuity by design).
 *    3. NO EMISSION    — notebook_edit's success output contains NO `fresh sha256`
 *                        substring (refresh-only, cell-op scope decision).
 *    4. SAFETY         — an EXTERNAL modification (utimesSync to a future mtime)
 *                        after notebook_edit STILL trips stale_read on a chained
 *                        edit: the refresh did NOT neuter the guard's TOCTOU
 *                        protection.
 *    5. NOTEBOOK→NOTEBOOK — two sequential notebook_edit cell edits (no re-read
 *                        between) both survive the DEFAULT-ON guard (each write
 *                        refreshes the baseline for the next).
 *
 *  This file does NOT touch any existing test file or any src file. */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultFileSystemPort } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"
import { makeNotebookEditTool } from "@/tool/notebook-edit/tool"
import { ReadFileState } from "@/tool/stale-read-guard"

const FRESH_RE = /fresh sha256: [0-9a-f]{64}/

/** A VALID nbformat v4 notebook whose cell-0 body contains the token we edit.
 *  `source` is the nbformat array-of-lines convention (each keeps its `\n`). */
const nbJson = (cell0Body: string): string =>
  JSON.stringify({
    cells: [
      {
        cell_type: "code",
        source: cell0Body.length === 0 ? [] : cell0Body.split(/(?<=\n)/),
        metadata: {},
        outputs: [],
        execution_count: null,
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })

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

/** Drive the REAL notebook_edit generator end-to-end; capture the terminal result. */
const runNotebook = async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of makeNotebookEditTool(defaultFileSystemPort).execute(input as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("notebook_edit: no result")
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

/** A str_replace op on cell 0: the schema's `mode` discriminator is EXPLICIT and
 *  `cell` is required (toOp: str_replace needs `cell` + `old_string`/`new_string`). */
const strReplace = (path: string, oldStr: string, newStr: string) => ({
  path,
  mode: "str_replace" as const,
  cell: 0,
  old_string: oldStr,
  new_string: newStr,
})

describe("jul-13 notebook_edit × edit-fresh-hash baseline refresh — PRODUCTION TRUTH (real fs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "notebook-fresh-hash-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("1. CORE GAP-CLOSE: read-record → notebook_edit str_replace → baseline refreshed → chained no-re-read edit SUCCEEDS", async () => {
    // The EXACT production sequence the refresh promises: read once → notebook_edit
    // rewrites the .ipynb (advancing its mtime) → a chained no-re-read edit to the
    // SAME file, all under the DEFAULT-ON guard. Before the refresh the chained
    // edit was rejected stale_read. Reverting `refreshStaleReadBaseline` in
    // notebook_edit flips this RED.
    const path = join(dir, "gap-close.ipynb")
    writeFileSync(path, nbJson("x = 1\n"), "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const ctx = prodCtx(dir, state, true)

    const r1 = await runNotebook(strReplace(path, "x = 1", "x = 2"), ctx)
    expect(r1.ok).toBe(true)
    // The edit landed in the notebook's cell 0.
    expect(readFileSync(path, "utf8")).toContain("x = 2")

    // The write advanced the file's mtime AND the refresh re-recorded the baseline
    // to it (the crux — this is the recorded-mtime == on-disk-mtime pin).
    expect(state.recordedMtime(path)).toBe(statSync(path).mtimeMs)

    // Chained edit, NO re-read: an `edit` on the notebook JSON's now-current bytes.
    const r2 = await runEdit({ path, old_string: "x = 2", new_string: "x = 3" }, ctx)
    expect(r2.ok).toBe(true)
    expect(r2.failure).toBeUndefined()
    expect(readFileSync(path, "utf8")).toContain("x = 3")
  })

  test("2. GATING (PAIRED CONTROL): editFreshHash ABSENT ⇒ no refresh ⇒ chained no-re-read edit FAILS stale_read", async () => {
    // The mirror of test 1 with the ONLY difference being the flag off. notebook_edit
    // does NOT refresh the baseline (byte-identical legacy), so the file's advanced
    // post-write mtime is now > the read-time baseline the guard still holds — the
    // chained edit is rejected stale_read. This is the NON-VACUITY proof: test 1
    // succeeds ONLY because of the refresh this test's absence isolates.
    const path = join(dir, "gating-off.ipynb")
    writeFileSync(path, nbJson("x = 1\n"), "utf8")
    const state = new ReadFileState()
    const readTimeMtime = recordReadTimeMtime(state, path)
    // Flag OFF ⇒ ctx.editFreshHash absent. The guard (readFileState) is still wired
    // exactly as production, isolating the refresh as the sole variable vs test 1.
    const ctx = prodCtx(dir, state, false)

    const r1 = await runNotebook(strReplace(path, "x = 1", "x = 2"), ctx)
    expect(r1.ok).toBe(true)
    expect(readFileSync(path, "utf8")).toContain("x = 2")

    // OFF ⇒ baseline untouched by the notebook write: still the pre-edit read-time mtime.
    expect(state.recordedMtime(path)).toBe(readTimeMtime)
    // And the notebook write advanced the on-disk mtime past that stale baseline.
    expect(statSync(path).mtimeMs).toBeGreaterThan(readTimeMtime)

    // The chained no-re-read edit is now vetoed stale_read (the defeat, un-cured).
    const r2 = await runEdit({ path, old_string: "x = 2", new_string: "x = 3" }, ctx)
    expect(r2.ok).toBe(false)
    expect(r2.failure?.mode).toBe("rejected")
    expect((r2.failure as { reason?: string } | undefined)?.reason).toBe("stale_read")
    // The rejected edit never landed — the notebook's edited bytes are intact.
    expect(readFileSync(path, "utf8")).toContain("x = 2")
    expect(readFileSync(path, "utf8")).not.toContain("x = 3")
  })

  test("3. NO EMISSION: notebook_edit success output contains NO `fresh sha256` substring (refresh-only, cell-op scope)", async () => {
    // Unlike edit/write/scripted_replace, notebook_edit does NOT emit a fresh-hash
    // manifest — it is cell-op based and does not consume `expected_hash`. The
    // correctness refresh ships; emission is intentionally out of scope.
    const path = join(dir, "no-emit.ipynb")
    writeFileSync(path, nbJson("x = 1\n"), "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const ctx = prodCtx(dir, state, true)

    const r = await runNotebook(strReplace(path, "x = 1", "x = 2"), ctx)
    expect(r.ok).toBe(true)
    expect(r.output ?? "").not.toMatch(FRESH_RE)
    expect(r.output ?? "").not.toContain("fresh sha256")

    // Positive contrast: an `edit` to the SAME file under the SAME flag DOES emit,
    // proving the absence above is notebook_edit-specific, not a flag-off artefact.
    const rEdit = await runEdit({ path, old_string: "x = 2", new_string: "x = 3" }, ctx)
    expect(rEdit.ok).toBe(true)
    expect(rEdit.output ?? "").toMatch(FRESH_RE)
  })

  test("4. SAFETY: an EXTERNAL modification after notebook_edit STILL trips stale_read on a chained edit (guard not neutered)", async () => {
    // The refresh records the notebook write's OWN post-commit mtime — it must NOT
    // blind the guard to a real external clobber. After the write, an out-of-band
    // writer touches the file to a definitively-later mtime; a chained no-re-read
    // edit must be rejected stale_read, so the TOCTOU protection survives.
    const path = join(dir, "external-clobber.ipynb")
    writeFileSync(path, nbJson("x = 1\n"), "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const ctx = prodCtx(dir, state, true)

    const r1 = await runNotebook(strReplace(path, "x = 1", "x = 2"), ctx)
    expect(r1.ok).toBe(true)
    // Refresh landed: baseline == post-commit on-disk mtime.
    expect(state.recordedMtime(path)).toBe(statSync(path).mtimeMs)

    // EXTERNAL clobber: a real out-of-band writer changes the notebook's CONTENT
    // (an added cell source), then forces the mtime clearly after what the
    // notebook write recorded. Touching the mtime alone no longer models an
    // external write: content is the stale-read authority now, and identical
    // bytes under a newer mtime are deliberately NOT a stale read.
    const clobbered = readFileSync(path, "utf8").replace("x = 2", "x = 2\\nz = 9")
    writeFileSync(path, clobbered, "utf8")
    const future = new Date(Date.now() + 60_000)
    utimesSync(path, future, future)
    expect(statSync(path).mtimeMs).toBeGreaterThan(state.recordedMtime(path) as number)

    // The guard still fires on the external change — the refresh did not disable TOCTOU.
    const r2 = await runEdit({ path, old_string: "x = 2", new_string: "x = 3" }, ctx)
    expect(r2.ok).toBe(false)
    expect(r2.failure?.mode).toBe("rejected")
    expect((r2.failure as { reason?: string } | undefined)?.reason).toBe("stale_read")
    // The rejected edit never landed, and the out-of-band writer's bytes survive.
    expect(readFileSync(path, "utf8")).toContain("x = 2")
    expect(readFileSync(path, "utf8")).not.toContain("x = 3")
    expect(readFileSync(path, "utf8")).toContain("z = 9")
  })

  test("5. NOTEBOOK→NOTEBOOK chain: two sequential cell edits (no re-read between) both survive the DEFAULT-ON guard", async () => {
    // Prove the refresh works notebook→notebook, not only notebook→edit: each
    // notebook_edit write refreshes the baseline for the next, so a second cell edit
    // with NO intervening re-read is not spuriously stale.
    const path = join(dir, "nb-to-nb.ipynb")
    writeFileSync(path, nbJson("x = 1\n"), "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const ctx = prodCtx(dir, state, true)

    const r1 = await runNotebook(strReplace(path, "x = 1", "x = 2"), ctx)
    expect(r1.ok).toBe(true)
    expect(state.recordedMtime(path)).toBe(statSync(path).mtimeMs)

    // Second notebook_edit, NO re-read between — survives only because r1 refreshed.
    const r2 = await runNotebook(strReplace(path, "x = 2", "x = 3"), ctx)
    expect(r2.ok).toBe(true)
    expect(r2.failure).toBeUndefined()
    expect(state.recordedMtime(path)).toBe(statSync(path).mtimeMs)
    expect(readFileSync(path, "utf8")).toContain("x = 3")
    expect(readFileSync(path, "utf8")).not.toContain("x = 2")
  })
})
