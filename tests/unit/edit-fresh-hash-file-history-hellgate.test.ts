/** jul-13 hellgate — file_history_rewind (op:"restore") × edit-fresh-hash
 *  STALE-READ BASELINE REFRESH under the DEFAULT-ON mtime stale-read guard (ADR-0474).
 *
 *  WHY THIS FILE EXISTS: `file_history_rewind`'s `op:"restore"` OVERWRITES a file
 *  with a PRIOR version's bytes (advancing its on-disk mtime) through the SAME
 *  jailed FS port `edit`/`write` use, and runs under the SAME DEFAULT-ON mtime
 *  stale-read guard (ADR-0474, strict `>` on mtime, keyed by resolved path). An
 *  adversarial completeness ratchet found `restore` was MISSING the post-write
 *  baseline refresh — so a CHAINED (no-re-read) edit to the just-restored file was
 *  falsely vetoed `stale_read`, because the restore write advanced the file's mtime
 *  past the read-time baseline the guard still held.
 *
 *  THE FIX (was real, now cured): `src/tool/file-history/tool.ts` `restore()` now
 *  calls `refreshStaleReadBaseline(fs, ctx, { path: key, base: ctx.cwd })` after the
 *  successful write (before the success return). It re-stats the just-restored file
 *  and re-records its post-commit mtime via the shared `recordFreshBaseline`, so a
 *  chained edit is fresh. It is REFRESH-ONLY: restore does NOT consume/emit
 *  `expected_hash` (it is not a chainable expected_hash text edit — content-match
 *  still guards a stale mental model), so — like apply_patch / notebook_edit — it
 *  deliberately emits NO `fresh sha256` manifest. Gated by `ctx.editFreshHash`
 *  (DEFAULT-ON, opt-out `QUANTA_EDIT_FRESH_HASH=off`) ⇒ byte-identical when off.
 *
 *  WHAT THIS FILE PINS (all against a REAL tmpdir fs with a REAL ReadFileState wired
 *  exactly as production wires it — Home-bonus ZERO, mutation-resistant):
 *    1. CORE GAP-CLOSE — seed a file + record v1/v2 in the store → read-record the
 *                        file's mtime → op:"restore" to v1 (advances mtime) →
 *                        baseline == on-disk mtime (refresh landed) → a chained
 *                        no-re-read `edit` to the restored file SUCCEEDS (no
 *                        stale_read). The restored bytes are v1's, so the edit's
 *                        old_string is a token that EXISTS in v1 (content-match
 *                        passes). Before the fix: stale_read RED.
 *    2. GATING (PAIRED CONTROL) — with editFreshHash ABSENT, restore does NOT
 *                        refresh ⇒ the chained no-re-read edit FAILS
 *                        `{mode:"rejected", reason:"stale_read"}`. Isolates the
 *                        refresh as the SOLE cure (test 1 succeeds ONLY because of
 *                        it — non-vacuity by design).
 *    3. NO EMISSION    — the restore success output ("Restored ... to vN") contains
 *                        NO `fresh sha256` substring (refresh-only scope decision).
 *    4. SAFETY         — an EXTERNAL modification (utimesSync to a future mtime)
 *                        after restore STILL trips stale_read on a chained edit: the
 *                        refresh did NOT neuter the guard's TOCTOU protection.
 *
 *  This file does NOT touch any existing test file or any src file. */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultFileSystemPort, resolveJailed } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"
import { createFileHistoryStore, makeFileHistoryRewindTool } from "@/tool/file-history"
import type { FileHistoryStore } from "@/tool/file-history/store"
import { ReadFileState } from "@/tool/stale-read-guard"

const FRESH_RE = /fresh sha256: [0-9a-f]{64}/

/** v1 / v2 bodies — v1 holds a UNIQUE token (`FROM_V1`) that v2 does NOT, so a
 *  restore-to-v1 followed by an `edit` whose old_string is `FROM_V1` proves BOTH
 *  that the restore wrote v1's bytes AND that content-match passes (the token
 *  exists in the restored file). */
const V1_BODY = "alpha FROM_V1 beta\n"
const V2_BODY = "alpha CURRENT_V2 beta\n"

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

/** Drive the REAL file_history_rewind generator end-to-end; capture the terminal
 *  result. The store + FS port are injected exactly as the host wires them. */
const runRewind = async (
  store: FileHistoryStore,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of makeFileHistoryRewindTool(store, defaultFileSystemPort).execute(
    input as never,
    ctx,
  )) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("file_history_rewind: no result")
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
 *  absolute path + its mtimeMs (the read-time baseline the model "saw"). Keys on
 *  the SAME jailed path the tool + guard resolve to. */
const recordReadTimeMtime = (state: ReadFileState, cwd: string, absPath: string): number => {
  const key = resolveJailed(absPath, cwd)
  const m = statSync(key).mtimeMs
  state.record(key, m)
  return m
}

/** Seed a file at its v2 bytes on disk AND record v1 then v2 in the store, mirroring
 *  how the capture sink records a version on each write/edit this session (the store
 *  keys on the SAME `resolveJailed` path the tool resolves). Returns { path, v1 } so
 *  the caller can restore to v1's ordinal. */
const seedWithHistory = (
  store: FileHistoryStore,
  cwd: string,
  name: string,
): { readonly path: string; readonly v1: number } => {
  const path = join(cwd, name)
  // On-disk state = the CURRENT (v2) bytes, as if the last write left v2.
  writeFileSync(path, V2_BODY, "utf8")
  const key = resolveJailed(path, cwd)
  // Record v1 (earlier) then v2 (current head) — the harness records a version per
  // write/edit, so a two-write session leaves exactly this timeline.
  const v1 = store.record(key, V1_BODY)
  store.record(key, V2_BODY)
  return { path, v1: v1.version }
}

describe("jul-13 file_history_rewind restore × edit-fresh-hash baseline refresh — PRODUCTION TRUTH (real fs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-history-fresh-hash-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const newStore = (): FileHistoryStore =>
    // Deterministic injected clock (no Date.now in the pure core) — the value is
    // irrelevant to the mtime guard, which keys on the REAL on-disk mtime.
    createFileHistoryStore({ now: () => 1_000 })

  test("1. CORE GAP-CLOSE: record v1/v2 → read-record → restore→v1 → baseline refreshed → chained no-re-read edit SUCCEEDS", async () => {
    // The EXACT production sequence the refresh promises: two writes leave a v1/v2
    // timeline → read once (baseline = current mtime) → restore→v1 rewrites the file
    // to v1's bytes (advancing its mtime) → a chained no-re-read edit to the SAME
    // file, all under the DEFAULT-ON guard. Before the refresh the chained edit was
    // rejected stale_read. Reverting `refreshStaleReadBaseline` in restore() flips
    // this RED.
    const store = newStore()
    const { path, v1 } = seedWithHistory(store, dir, "gap-close.txt")
    const state = new ReadFileState()
    recordReadTimeMtime(state, dir, path)
    const ctx = prodCtx(dir, state, true)

    const r1 = await runRewind(store, { op: "restore", path, version: v1 }, ctx)
    expect(r1.ok).toBe(true)
    // The restore wrote v1's bytes back (v1's unique token present, v2's gone).
    expect(readFileSync(path, "utf8")).toBe(V1_BODY)
    expect(readFileSync(path, "utf8")).toContain("FROM_V1")

    // The write advanced the file's mtime AND the refresh re-recorded the baseline
    // to it (the crux — recorded-mtime == on-disk-mtime pin, keyed on the jailed path).
    const key = resolveJailed(path, dir)
    expect(state.recordedMtime(key)).toBe(statSync(key).mtimeMs)

    // Chained edit, NO re-read: old_string is v1's token (content-match passes only
    // because the restore actually wrote v1's bytes). Survives the guard ONLY because
    // restore refreshed the baseline.
    const r2 = await runEdit(
      { path, old_string: "FROM_V1", new_string: "EDITED_AFTER_RESTORE" },
      ctx,
    )
    expect(r2.ok).toBe(true)
    expect(r2.failure).toBeUndefined()
    expect(readFileSync(path, "utf8")).toContain("EDITED_AFTER_RESTORE")
  })

  test("2. GATING (PAIRED CONTROL): editFreshHash ABSENT ⇒ no refresh ⇒ chained no-re-read edit FAILS stale_read", async () => {
    // The mirror of test 1 with the ONLY difference being the flag off. restore does
    // NOT refresh the baseline (byte-identical legacy), so the file's advanced
    // post-restore mtime is now > the read-time baseline the guard still holds — the
    // chained edit is rejected stale_read. This is the NON-VACUITY proof: test 1
    // succeeds ONLY because of the refresh this test's absence isolates.
    const store = newStore()
    const { path, v1 } = seedWithHistory(store, dir, "gating-off.txt")
    const state = new ReadFileState()
    const readTimeMtime = recordReadTimeMtime(state, dir, path)
    // Flag OFF ⇒ ctx.editFreshHash absent. The guard (readFileState) is still wired
    // exactly as production, isolating the refresh as the sole variable vs test 1.
    const ctx = prodCtx(dir, state, false)

    const r1 = await runRewind(store, { op: "restore", path, version: v1 }, ctx)
    expect(r1.ok).toBe(true)
    expect(readFileSync(path, "utf8")).toBe(V1_BODY)

    const key = resolveJailed(path, dir)
    // OFF ⇒ baseline untouched by the restore write: still the pre-restore read-time mtime.
    expect(state.recordedMtime(key)).toBe(readTimeMtime)
    // And the restore write advanced the on-disk mtime past that stale baseline.
    expect(statSync(key).mtimeMs).toBeGreaterThan(readTimeMtime)

    // The chained no-re-read edit is now vetoed stale_read (the defeat, un-cured).
    const r2 = await runEdit(
      { path, old_string: "FROM_V1", new_string: "EDITED_AFTER_RESTORE" },
      ctx,
    )
    expect(r2.ok).toBe(false)
    expect(r2.failure?.mode).toBe("rejected")
    expect((r2.failure as { reason?: string } | undefined)?.reason).toBe("stale_read")
    // The rejected edit never landed — v1's restored bytes are intact.
    expect(readFileSync(path, "utf8")).toBe(V1_BODY)
    expect(readFileSync(path, "utf8")).not.toContain("EDITED_AFTER_RESTORE")
  })

  test("3. NO EMISSION: restore success output contains NO `fresh sha256` substring (refresh-only scope)", async () => {
    // Unlike edit/write/scripted_replace, restore does NOT emit a fresh-hash manifest
    // — it does not consume `expected_hash`. The correctness refresh ships; emission
    // is intentionally out of scope.
    const store = newStore()
    const { path, v1 } = seedWithHistory(store, dir, "no-emit.txt")
    const state = new ReadFileState()
    recordReadTimeMtime(state, dir, path)
    const ctx = prodCtx(dir, state, true)

    const r = await runRewind(store, { op: "restore", path, version: v1 }, ctx)
    expect(r.ok).toBe(true)
    expect(r.output ?? "").toContain(`to v${v1}`)
    expect(r.output ?? "").not.toMatch(FRESH_RE)
    expect(r.output ?? "").not.toContain("fresh sha256")

    // Positive contrast: an `edit` to the SAME file under the SAME flag DOES emit,
    // proving the absence above is restore-specific, not a flag-off artefact.
    const rEdit = await runEdit({ path, old_string: "FROM_V1", new_string: "FROM_V1_X" }, ctx)
    expect(rEdit.ok).toBe(true)
    expect(rEdit.output ?? "").toMatch(FRESH_RE)
  })

  test("4. SAFETY: an EXTERNAL modification after restore STILL trips stale_read on a chained edit (guard not neutered)", async () => {
    // The refresh records the restore write's OWN post-commit mtime — it must NOT
    // blind the guard to a real external clobber. After the restore, an out-of-band
    // writer touches the file to a definitively-later mtime; a chained no-re-read
    // edit must be rejected stale_read, so the TOCTOU protection survives.
    const store = newStore()
    const { path, v1 } = seedWithHistory(store, dir, "external-clobber.txt")
    const state = new ReadFileState()
    recordReadTimeMtime(state, dir, path)
    const ctx = prodCtx(dir, state, true)

    const r1 = await runRewind(store, { op: "restore", path, version: v1 }, ctx)
    expect(r1.ok).toBe(true)
    const key = resolveJailed(path, dir)
    // Refresh landed: baseline == post-commit on-disk mtime.
    expect(state.recordedMtime(key)).toBe(statSync(key).mtimeMs)

    // EXTERNAL clobber: force the mtime clearly AFTER what the restore recorded
    // (deterministic — not dependent on fs mtime granularity).
    const future = new Date(Date.now() + 60_000)
    utimesSync(key, future, future)
    expect(statSync(key).mtimeMs).toBeGreaterThan(state.recordedMtime(key) as number)

    // The guard still fires on the external change — the refresh did not disable TOCTOU.
    const r2 = await runEdit(
      { path, old_string: "FROM_V1", new_string: "EDITED_AFTER_RESTORE" },
      ctx,
    )
    expect(r2.ok).toBe(false)
    expect(r2.failure?.mode).toBe("rejected")
    expect((r2.failure as { reason?: string } | undefined)?.reason).toBe("stale_read")
    // The rejected edit never landed — v1's restored bytes are intact.
    expect(readFileSync(path, "utf8")).toBe(V1_BODY)
    expect(readFileSync(path, "utf8")).not.toContain("EDITED_AFTER_RESTORE")
  })
})
