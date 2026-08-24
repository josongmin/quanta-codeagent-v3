/** jul-13 hellgate — edit-fresh-hash × DEFAULT-ON mtime stale-read guard (ADR-0474).
 *
 *  WHY THIS FILE EXISTS: an adversarial hardening pass found — and this suite now
 *  pins the CURE for — a PRODUCTION DEFEAT. The other fresh-hash tests wire only
 *  `{ cwd, signal, editFreshHash }` and NEVER `ctx.readFileState`, so they ran in
 *  a world where the DEFAULT-ON stale-read guard was inert. In production
 *  `agent-config-assembler.maybeWireReadFileState` mints a live `ReadFileState`
 *  unless `QUANTA_STALE_READ_GUARD=off`, so the real ToolContext carries BOTH.
 *
 *  THE DEFEAT (was real): `read` records the read-time mtime (read/index.ts:570);
 *  `edit`'s pre-commit guard (`editPreCommitDeny` → `guardWrite`, strict `>` on
 *  mtime) REJECTS with `stale_read` when the on-disk mtime advanced past the
 *  recorded value. A successful edit advances the file's mtime — so a CHAINED edit
 *  that (by design) skips the re-read hit `stale_read` even with a correct fresh
 *  `expected_hash`. The fresh-hash "no re-read" promise was defeated by the guard.
 *
 *  THE FIX (landed, gated): after `commitEdit`, when `ctx.editFreshHash` is on, the
 *  edit records the JUST-WRITTEN mtime (`refreshStaleReadBaseline` in
 *  edit/index.ts) — a successful edit IS a fresh read of its own output. Gated by
 *  the SAME flag ⇒ byte-identical (no stat, no state mutation) when off.
 *
 *  WHAT THIS FILE PINS (all against a REAL fs with a REAL ReadFileState wired
 *  exactly as production wires it):
 *    1. FIX WITNESS  — edit refreshes the guard baseline to the post-write mtime.
 *    2. CHAIN SURVIVES — the fresh-hash chain succeeds under the DEFAULT-ON guard.
 *    3. GATING        — with the flag OFF the baseline is NOT refreshed (byte-id).
 *    4. SAFETY        — an EXTERNAL modification after the edit STILL trips
 *                       stale_read: the fix did NOT neuter the guard's TOCTOU job.
 *    5. worktree + fast-apply-merge success paths chain correctly too.
 *
 *  This file does NOT touch any existing test file. */

import { afterAll, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultFileSystemPort, sha256Hex } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"
import { ReadFileState } from "@/tool/stale-read-guard"

const FRESH_RE = /fresh sha256: ([0-9a-f]{64})/

/** Production-faithful ToolContext: DEFAULT-ON stale-read guard (a live
 *  `ReadFileState`) AND `editFreshHash` on — exactly what a default session mints. */
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

const runEdit = async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of makeEditTool(defaultFileSystemPort).execute(input as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

/** Model the `read` tool's recording exactly (read/index.ts:570): stat the file,
 *  record the RESOLVED absolute path + its mtimeMs. */
const recordReadTimeMtime = (state: ReadFileState, absPath: string): number => {
  const m = statSync(absPath).mtimeMs
  state.record(absPath, m)
  return m
}

describe("jul-13 edit-fresh-hash × DEFAULT-ON mtime guard — PRODUCTION TRUTH (real fs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fresh-hash-mtime-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("1. FIX WITNESS: a successful edit refreshes the guard baseline to the post-write mtime", async () => {
    // The cure in one assertion: after edit #1 the guard's recorded mtime now
    // equals the JUST-WRITTEN on-disk mtime (not the stale read-time value).
    // Reverting `refreshStaleReadBaseline` in edit/index.ts flips this RED
    // (recorded would fall back to the read-time mtime < on-disk).
    const path = join(dir, "record-witness.txt")
    writeFileSync(path, "x = 1\ny = 1", "utf8")
    const state = new ReadFileState()
    const readTimeMtime = recordReadTimeMtime(state, path)

    const r1 = await runEdit(
      { path, old_string: "x = 1", new_string: "x = 2" },
      prodCtx(dir, state, true),
    )
    expect(r1.ok).toBe(true)

    const onDiskAfter = statSync(path).mtimeMs
    const recordedAfter = state.recordedMtime(path)
    // The edit advanced the file's mtime...
    expect(onDiskAfter).toBeGreaterThanOrEqual(readTimeMtime)
    // ...and the edit refreshed the baseline to that post-write mtime.
    expect(recordedAfter).toBe(onDiskAfter)
  })

  test("2. CHAIN SURVIVES: chained same-file edit with the advertised fresh hash SUCCEEDS under the default-ON guard", async () => {
    // The exact production sequence the feature promises: read once → edit #1 →
    // edit #2 to the SAME file with the advertised hash and NO re-read — all under
    // the DEFAULT-ON guard. Before the fix this was rejected `stale_read`.
    const path = join(dir, "chain-fixed.txt")
    writeFileSync(path, "let x = 1\nlet y = 1", "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const ctx = prodCtx(dir, state, true)

    const r1 = await runEdit({ path, old_string: "x = 1", new_string: "x = 2" }, ctx)
    expect(r1.ok).toBe(true)
    const advertised = r1.output?.match(FRESH_RE)?.[1]
    expect(advertised).toBeDefined()
    expect(advertised).toBe(sha256Hex(readFileSync(path, "utf8")))

    const r2 = await runEdit(
      { path, old_string: "y = 1", new_string: "y = 2", expected_hash: advertised },
      ctx,
    )
    // Fixed: the guard baseline was refreshed by edit #1, so edit #2 is fresh.
    expect(r2.ok).toBe(true)
    expect(r2.failure).toBeUndefined()
    expect(readFileSync(path, "utf8")).toBe("let x = 2\nlet y = 2")
  })

  test("3. GATING: with editFreshHash OFF the baseline is NOT refreshed (byte-identical legacy)", async () => {
    // The refresh is gated by the same flag. OFF ⇒ no stat, no record ⇒ the guard
    // baseline stays at the read-time mtime exactly as pre-feature. (A chained
    // no-re-read edit is not a concern when off — the model re-reads.)
    const path = join(dir, "gating-off.txt")
    writeFileSync(path, "x = 1\ny = 1", "utf8")
    const state = new ReadFileState()
    const readTimeMtime = recordReadTimeMtime(state, path)

    const r1 = await runEdit(
      { path, old_string: "x = 1", new_string: "x = 2" },
      prodCtx(dir, state, false),
    )
    expect(r1.ok).toBe(true)
    // OFF ⇒ baseline untouched by the edit.
    expect(state.recordedMtime(path)).toBe(readTimeMtime)
  })

  test("4. SAFETY: an EXTERNAL modification after the edit STILL trips stale_read (guard not neutered)", async () => {
    // The fix records the edit's OWN post-write mtime — it must NOT blind the guard
    // to a real external clobber. After edit #1, simulate an out-of-band writer
    // touching the file to a definitively-later mtime; a chained edit (no re-read)
    // must be rejected stale_read even with a syntactically-valid fresh hash, so
    // the TOCTOU protection the guard exists for is preserved.
    const path = join(dir, "external-clobber.txt")
    writeFileSync(path, "let x = 1\nlet y = 1", "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const ctx = prodCtx(dir, state, true)

    const r1 = await runEdit({ path, old_string: "x = 1", new_string: "x = 2" }, ctx)
    expect(r1.ok).toBe(true)
    const advertised = r1.output?.match(FRESH_RE)?.[1]

    // EXTERNAL clobber: a real out-of-band writer — the file's CONTENT changes,
    // and its mtime is then forced clearly after what the edit recorded
    // (deterministic — not dependent on fs mtime granularity).
    //
    // This used to touch the mtime ALONE, as a cheap stand-in for an external
    // write. That stand-in stopped being equivalent when the stale-read
    // authority moved from mtime to CONTENT: an mtime that advanced over
    // identical bytes is now — deliberately — not a stale read, so the old
    // simulation asserted the retired mechanism rather than the property.
    // `y = 1` is left intact so edit #2 still MATCHES: the refusal below is the
    // guard, not a failed search.
    writeFileSync(path, "let x = 2\nlet y = 1\nlet CLOBBERED = 1", "utf8")
    const future = new Date(Date.now() + 60_000)
    utimesSync(path, future, future)
    expect(statSync(path).mtimeMs).toBeGreaterThan(state.recordedMtime(path) as number)

    const r2 = await runEdit(
      { path, old_string: "y = 1", new_string: "y = 2", expected_hash: advertised },
      ctx,
    )
    // Refused, and the out-of-band writer's bytes SURVIVE — no lost update.
    // That is the property; which of the two gates catches it is an
    // implementation detail, and here the hash precondition is first.
    expect(r2.ok).toBe(false)
    expect(r2.failure?.mode).toBe("stale_precondition")
    expect(readFileSync(path, "utf8")).toBe("let x = 2\nlet y = 1\nlet CLOBBERED = 1")
  })

  test("5. ISOLATION: with the guard OFF (readFileState unwired) the chain also succeeds — the fix targets the guard interaction only", async () => {
    const path = join(dir, "chain-guard-off.txt")
    writeFileSync(path, "let x = 1\nlet y = 1", "utf8")
    const ctx = prodCtx(dir, undefined, true) // no readFileState ⇒ guard inert

    const r1 = await runEdit({ path, old_string: "x = 1", new_string: "x = 2" }, ctx)
    expect(r1.ok).toBe(true)
    const advertised = r1.output?.match(FRESH_RE)?.[1]
    const r2 = await runEdit(
      { path, old_string: "y = 1", new_string: "y = 2", expected_hash: advertised },
      ctx,
    )
    expect(r2.ok).toBe(true)
    expect(readFileSync(path, "utf8")).toBe("let x = 2\nlet y = 2")
  })
})

describe("jul-13 edit-fresh-hash × mtime guard — worktree-resolved path", () => {
  const session = mkdtempSync(join(tmpdir(), "fresh-hash-wt-"))
  afterAll(() => rmSync(session, { recursive: true, force: true }))

  test("under an active worktree the chain survives: baseline refresh, guard stat, and advertised hash all key on the WORKTREE-resolved path", async () => {
    const worktree = join(session, "wt")
    mkdirSync(worktree, { recursive: true })
    const rel = "app.txt"
    const resolved = join(worktree, rel)
    writeFileSync(resolved, "a = 1\nb = 1", "utf8")

    const state = new ReadFileState()
    state.record(resolved, statSync(resolved).mtimeMs) // read records under resolved path

    const ctx: ToolContext = {
      cwd: session,
      signal: new AbortController().signal,
      readFileState: state,
      editFreshHash: true,
      activeWorktree: {
        worktreePath: worktree,
        branch: "test-wt",
        isPersistent: false,
        repoRoot: session,
        branchFrom: "head",
      },
    }

    const r1 = await runEdit({ path: rel, old_string: "a = 1", new_string: "a = 2" }, ctx)
    expect(r1.ok).toBe(true)
    const advertised = r1.output?.match(FRESH_RE)?.[1]
    expect(advertised).toBe(sha256Hex(readFileSync(resolved, "utf8")))
    // The baseline refresh keyed on the worktree-resolved path ⇒ edit #2 is fresh.
    expect(state.recordedMtime(resolved)).toBe(statSync(resolved).mtimeMs)

    const r2 = await runEdit(
      { path: rel, old_string: "b = 1", new_string: "b = 2", expected_hash: advertised },
      ctx,
    )
    expect(r2.ok).toBe(true)
    expect(readFileSync(resolved, "utf8")).toBe("a = 2\nb = 2")
  })
})

describe("jul-13 edit-fresh-hash × mtime guard — fast-apply-merge success path", () => {
  const dir = mkdtempSync(join(tmpdir(), "fresh-hash-merge-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("a fast-apply-merge success advertises the hash over the MERGED bytes AND refreshes the baseline so a chained edit survives", async () => {
    const path = join(dir, "merge.txt")
    writeFileSync(path, "alpha\nbeta\n", "utf8")
    const merged = "alpha\nBETA_MERGED\n"

    const state = new ReadFileState()
    recordReadTimeMtime(state, path)

    const ctx: ToolContext = {
      cwd: dir,
      signal: new AbortController().signal,
      readFileState: state,
      editFreshHash: true,
      fastApplyMerge: {
        async apply(_input: { original: string; editSketch: string; path?: string }) {
          return { ok: true as const, merged, rationale: "test merge" }
        },
      },
      // 0661ed316 hardening: the merge rung now REFUSES to land a model merge
      // unless the host wired an explicit pre-commit reviewer (a whole-file
      // model merge has no deterministic semantic-preservation proof). Wire an
      // approving reviewer so this test exercises the SUCCESS path it pins;
      // the reviewer-absent refusal is covered separately below.
      fastApplyMergeReview: {
        async approve() {
          return true
        },
      },
    }

    // old_string absent verbatim → exact+fuzzy miss → merge rung → verified merge.
    const r1 = await runEdit(
      { path, old_string: "beta_MISSING_ANCHOR", new_string: "BETA_MERGED" },
      ctx,
    )
    expect(r1.ok).toBe(true)
    expect(r1.output).toContain("fast-apply merge")
    const advertised = r1.output?.match(FRESH_RE)?.[1]
    // (a) advertised hash is over the MERGED bytes that landed on disk.
    expect(readFileSync(path, "utf8")).toBe(merged)
    expect(advertised).toBe(sha256Hex(merged))
    expect(advertised).not.toBe(sha256Hex("alpha\nbeta\n")) // red-on-injection

    // (b) the merge success also refreshed the baseline → chained edit survives.
    expect(state.recordedMtime(path)).toBe(statSync(path).mtimeMs)
    const r2 = await runEdit(
      { path, old_string: "alpha", new_string: "ALPHA2", expected_hash: advertised },
      ctx,
    )
    expect(r2.ok).toBe(true)
    expect(readFileSync(path, "utf8")).toBe("ALPHA2\nBETA_MERGED\n")
  })

  test("the merge rung REFUSES to land (falls through to typed mismatch) when NO pre-commit reviewer is wired (0661ed316 mandatory-review gate)", async () => {
    // Load-bearing counterpart to the success path above: with `fastApplyMerge`
    // wired but `fastApplyMergeReview` ABSENT, a whole-file model merge has no
    // semantic-preservation proof, so the rung must NOT land it — it falls
    // through to the byte-identical typed mismatch and the file is unchanged.
    const path = join(dir, "no-reviewer.txt")
    writeFileSync(path, "alpha\nbeta\n", "utf8")

    const ctx: ToolContext = {
      cwd: dir,
      signal: new AbortController().signal,
      editFreshHash: true,
      fastApplyMerge: {
        async apply(_input: { original: string; editSketch: string; path?: string }) {
          return { ok: true as const, merged: "alpha\nBETA_MERGED\n", rationale: "test merge" }
        },
      },
      // fastApplyMergeReview intentionally omitted.
    }

    const r = await runEdit(
      { path, old_string: "beta_MISSING_ANCHOR", new_string: "BETA_MERGED" },
      ctx,
    )
    expect(r.ok).toBe(false)
    expect(r.output).not.toContain("fast-apply merge")
    // The file MUST be untouched — no unapproved model merge landed.
    expect(readFileSync(path, "utf8")).toBe("alpha\nbeta\n")
  })
})
