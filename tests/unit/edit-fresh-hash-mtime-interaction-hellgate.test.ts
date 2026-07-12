/** jul-13 hellgate — edit-fresh-hash × DEFAULT-ON mtime stale-read guard (ADR-0474).
 *
 *  WHY THIS FILE EXISTS (adversarial probe of a suspected PRODUCTION DEFEAT):
 *  The existing `edit-fresh-hash-hellgate.test.ts` proves the fresh-hash CHAIN
 *  works — BUT its ToolContext factory wires ONLY `{ cwd, signal, editFreshHash }`.
 *  It NEVER wires `ctx.readFileState`. That is NOT the default production config:
 *  the stale-read guard (ADR-0474) is DEFAULT-ON — `agent-config-assembler.ts`
 *  `maybeWireReadFileState` (L657-661) mints a `ReadFileState` unless the operator
 *  sets the EXACT strict kill-switch `QUANTA_STALE_READ_GUARD=off`
 *  (`stale-read-guard/gate.ts:44`). So the REAL production ToolContext carries
 *  BOTH `editFreshHash` AND `readFileState`.
 *
 *  THE HYPOTHESISED DEFEAT (proven below):
 *    1. `read` records the read-time mtime: `read/index.ts:570`
 *       `ctx.readFileState?.record(outcome.info.path, outcome.info.mtimeMs)`.
 *    2. `edit`'s pre-commit guard (`edit/index.ts:458-479` `editPreCommitDeny`)
 *       calls `guardWrite(ctx.readFileState, cur.path, cur.mtimeMs)` and REJECTS
 *       with `failure.mode:"rejected", reason:"stale_read"` when the on-disk mtime
 *       has advanced past the recorded read-time mtime (strict `>`, `state.ts:200`).
 *    3. A successful `edit` writes new bytes → the file's mtime ADVANCES. BUT the
 *       edit success path (`edit/index.ts:552-582`) NEVER calls
 *       `ctx.readFileState.record(...)` after `commitEdit`. (Grep confirms: the
 *       ONLY `.record(` on `readFileState` in the whole `src/tool/**` tree is in
 *       `read/index.ts`; edit + write only ever READ the state via `guardWrite`.)
 *
 *  ⇒ After edit #1, `readFileState` still holds the READ-TIME (pre-edit#1) mtime.
 *  When edit #2 arrives WITHOUT a re-read (the exact flow the fresh-hash fix
 *  ENABLES — "no re-read needed"), `guardWrite` sees `currentMtime (post-edit#1)
 *  > recorded (read-time)` ⇒ STALE_READ rejection — EVEN THOUGH edit #2 supplied
 *  the correct fresh `expected_hash`. The hash precondition passes, then the mtime
 *  guard vetoes. The fresh-hash fix is DEFEATED in the default-ON production config.
 *
 *  WHAT THIS FILE PINS: the CURRENT TRUE behavior with a REAL `ReadFileState`
 *  wired exactly as production wires it. If the defeat is real, these tests are
 *  GREEN because they assert the CURRENT (buggy) truth — `stale_read` — with a
 *  loud comment. A separate GREEN test proves the fresh-hash chain DOES work when
 *  the guard is OFF, isolating the guard (not the hash) as the cause. A paired
 *  no-op-edit "record-on-write is absent" witness makes the missing seam explicit.
 *
 *  EXACT FIX SEAM (documented, NOT applied — parallel agents on src): after
 *  `commitEdit(...)` succeeds in `edit/index.ts` `execute` (right where
 *  `captureFileHistory` runs, ~L566), the edit MUST refresh the guard baseline:
 *      if (ctx.readFileState !== undefined) {
 *        const s = await fs.statFile(target.path, target.base)
 *        ctx.readFileState.record(s.path, s.mtimeMs)
 *      }
 *  so the guard sees the file the edit ITSELF just wrote as the new baseline (an
 *  edit is by definition a fresh read-equivalent of its own output). The same seam
 *  is needed in `write/index.ts`. Without it, `editFreshHash` cannot deliver the
 *  "no re-read" it advertises whenever the DEFAULT-ON guard is active.
 *
 *  This file does NOT touch src or any existing test file. */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultFileSystemPort, sha256Hex } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"
import { ReadFileState } from "@/tool/stale-read-guard"

const FRESH_RE = /fresh sha256: ([0-9a-f]{64})/

/** Production-faithful ToolContext: DEFAULT-ON stale-read guard (a live
 *  `ReadFileState`) AND `editFreshHash` on — exactly what
 *  `agent-config-assembler.maybeWireReadFileState` mints for a default session. */
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

/** Model the `read` tool's recording exactly: it stats the file and records the
 *  RESOLVED absolute path + its mtimeMs (`read/index.ts:570`). We stat the same
 *  absolute path the edit tool will resolve (no worktree ⇒ the raw absolute path). */
const recordReadTimeMtime = (state: ReadFileState, absPath: string): number => {
  const m = statSync(absPath).mtimeMs
  state.record(absPath, m)
  return m
}

describe("jul-13 edit-fresh-hash × DEFAULT-ON mtime guard — PRODUCTION TRUTH (real fs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fresh-hash-mtime-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("edit does NOT re-record readFileState after a write (the missing seam)", async () => {
    // Directly witness the absent `record`-on-write: read-record the baseline,
    // perform an edit, then assert the guard's recorded mtime is UNCHANGED even
    // though the on-disk mtime advanced. This is the root cause in one assertion —
    // adding the fix seam (record post-write) turns this test RED (recorded would
    // then equal the post-write mtime), which is exactly the signal we want.
    const path = join(dir, "record-witness.txt")
    writeFileSync(path, "x = 1\ny = 1", "utf8")
    const state = new ReadFileState()
    const readTimeMtime = recordReadTimeMtime(state, path)

    const r1 = await runEdit(
      { path, old_string: "x = 1", new_string: "x = 2" },
      prodCtx(dir, state, true),
    )
    expect(r1.ok).toBe(true) // edit #1 itself passes: guard sees fresh (recorded == read-time == pre-write)

    const onDiskAfter = statSync(path).mtimeMs
    const recordedAfter = state.recordedMtime(path)
    // GROUND TRUTH: the edit advanced the file's mtime...
    expect(onDiskAfter).toBeGreaterThan(readTimeMtime)
    // ...but the guard baseline was NOT refreshed by the edit. Still the read-time
    // value → the guard now believes the file is STALE relative to what it holds.
    expect(recordedAfter).toBe(readTimeMtime)
    expect(recordedAfter).toBeLessThan(onDiskAfter)
  })

  test("🔴 DEFEAT: chained same-file edit with the advertised fresh hash is REJECTED as stale_read", async () => {
    // The EXACT production sequence the fresh-hash fix promises to enable:
    //   read once → edit #1 → edit #2 to the SAME file with the advertised fresh
    //   hash as expected_hash and NO re-read — all under the DEFAULT-ON guard.
    const path = join(dir, "chain-defeat.txt")
    writeFileSync(path, "let x = 1\nlet y = 1", "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const ctx = prodCtx(dir, state, true)

    // Edit #1 — succeeds; the guard's recorded mtime still == read-time (fresh).
    const r1 = await runEdit({ path, old_string: "x = 1", new_string: "x = 2" }, ctx)
    expect(r1.ok).toBe(true)
    const advertised = r1.output?.match(FRESH_RE)?.[1]
    expect(advertised).toBeDefined()
    // The advertised hash is HONEST: it equals sha256 of the actual on-disk bytes.
    expect(advertised).toBe(sha256Hex(readFileSync(path, "utf8")))

    // Edit #2 — same file, NO re-read (so `state` still holds the read-time mtime),
    // supplying the correct fresh hash. The hash precondition WOULD pass — but the
    // DEFAULT-ON mtime guard fires first-in-effect and vetoes with stale_read.
    const r2 = await runEdit(
      { path, old_string: "y = 1", new_string: "y = 2", expected_hash: advertised },
      ctx,
    )

    // ── PRODUCTION TRUTH (current behavior). If this flips to ok:true, the src fix
    //    (record-on-write) has landed and the defeat is cured → update this pin. ──
    expect(r2.ok).toBe(false)
    expect(r2.failure?.mode).toBe("rejected")
    expect((r2.failure as { reason?: string } | undefined)?.reason).toBe("stale_read")
    // The rejection is NOT the hash gate: the fresh hash was correct. Prove it was
    // the mtime guard, not stale_precondition (which would mean a wrong hash).
    expect(r2.failure?.mode).not.toBe("stale_precondition")
    // Edit #2 never landed — the file still holds only edit #1's change.
    expect(readFileSync(path, "utf8")).toBe("let x = 2\nlet y = 1")
  })

  test("✅ ISOLATION: with the guard OFF (readFileState unwired), the SAME chain succeeds", async () => {
    // Paired control isolating the CAUSE: identical inputs, only difference is the
    // guard is not wired (as when QUANTA_STALE_READ_GUARD=off, or as the existing
    // hellgate mistakenly always ran). The chain works → the hash logic is sound;
    // the DEFEAT above is caused SOLELY by the default-ON mtime guard, not the fix.
    const path = join(dir, "chain-guard-off.txt")
    writeFileSync(path, "let x = 1\nlet y = 1", "utf8")
    const ctx = prodCtx(dir, undefined, true) // no readFileState ⇒ guard inert

    const r1 = await runEdit({ path, old_string: "x = 1", new_string: "x = 2" }, ctx)
    expect(r1.ok).toBe(true)
    const advertised = r1.output?.match(FRESH_RE)?.[1]
    expect(advertised).toBeDefined()

    const r2 = await runEdit(
      { path, old_string: "y = 1", new_string: "y = 2", expected_hash: advertised },
      ctx,
    )
    expect(r2.ok).toBe(true)
    expect(r2.failure).toBeUndefined()
    expect(readFileSync(path, "utf8")).toBe("let x = 2\nlet y = 2")
  })

  test("PAIRED: re-reading between edits (recording the fresh mtime) DOES unblock edit #2", async () => {
    // Confirms the guard is behaving as designed — and that the fix seam is
    // precisely "record the post-write mtime". Here we simulate what a re-read (or
    // the missing record-on-write seam) would do: refresh the baseline to the
    // current on-disk mtime AFTER edit #1. Then edit #2 with the fresh hash passes.
    // This is the behavioral proof of the exact fix (record post-write mtime).
    const path = join(dir, "chain-reread.txt")
    writeFileSync(path, "let x = 1\nlet y = 1", "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const ctx = prodCtx(dir, state, true)

    const r1 = await runEdit({ path, old_string: "x = 1", new_string: "x = 2" }, ctx)
    expect(r1.ok).toBe(true)
    const advertised = r1.output?.match(FRESH_RE)?.[1]

    // ── The seam the edit SHOULD run itself (record the post-write mtime). Doing it
    //    here manually proves it is sufficient to cure the defeat. ──
    state.record(path, statSync(path).mtimeMs)

    const r2 = await runEdit(
      { path, old_string: "y = 1", new_string: "y = 2", expected_hash: advertised },
      ctx,
    )
    expect(r2.ok).toBe(true)
    expect(r2.failure).toBeUndefined()
    expect(readFileSync(path, "utf8")).toBe("let x = 2\nlet y = 2")
  })
})

describe("jul-13 edit-fresh-hash × mtime guard — worktree-resolved path probe", () => {
  const session = mkdtempSync(join(tmpdir(), "fresh-hash-wt-"))
  afterAll(() => rmSync(session, { recursive: true, force: true }))

  test("under an active worktree, guard baseline + edit stat + advertised hash all key on the WORKTREE-resolved path", async () => {
    // The worktree edit-fence resolves a RELATIVE path against the worktree dir
    // (resolveEditBase), and the guard stats `target.path` (that same resolved
    // path). The read tool records under the resolved `info.path` too. So the
    // read baseline, the guard stat, and the advertised-hash file are the SAME
    // physical file — this pins that alignment (a mismatch would either falsely
    // pass the guard or hash the wrong file). We record the read-time mtime under
    // the worktree-resolved absolute path, exactly as `read` would.
    const worktree = join(session, "wt")
    // The worktree dir is a subdir of the session jail; create it + the file.
    rmSync(worktree, { recursive: true, force: true })
    writeFileSync(join(session, ".keep"), "") // ensure session dir exists
    const { mkdirSync } = await import("node:fs")
    mkdirSync(worktree, { recursive: true })
    const rel = "app.txt"
    const resolved = join(worktree, rel)
    writeFileSync(resolved, "a = 1\nb = 1", "utf8")

    const state = new ReadFileState()
    // read records under the RESOLVED worktree path (info.path), not the raw rel.
    const readTime = statSync(resolved).mtimeMs
    state.record(resolved, readTime)

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

    // Edit #1 with the RAW RELATIVE path — the tool resolves it to `resolved`.
    const r1 = await runEdit({ path: rel, old_string: "a = 1", new_string: "a = 2" }, ctx)
    expect(r1.ok).toBe(true)
    const advertised = r1.output?.match(FRESH_RE)?.[1]
    expect(advertised).toBeDefined()
    // The advertised hash is over the WORKTREE file the edit actually wrote.
    expect(advertised).toBe(sha256Hex(readFileSync(resolved, "utf8")))
    expect(readFileSync(resolved, "utf8")).toBe("a = 2\nb = 1")

    // Edit #2 under the worktree, no re-read → SAME defeat as the non-worktree case:
    // the guard baseline (worktree-resolved path) still holds the read-time mtime,
    // the write advanced it, no record-on-write → stale_read. This confirms the
    // defeat is path-agnostic (worktree resolution is aligned, so the guard fires
    // on the correct — worktree — file exactly as it would in the flat case).
    const r2 = await runEdit(
      { path: rel, old_string: "b = 1", new_string: "b = 2", expected_hash: advertised },
      ctx,
    )
    expect(r2.ok).toBe(false)
    expect(r2.failure?.mode).toBe("rejected")
    expect((r2.failure as { reason?: string } | undefined)?.reason).toBe("stale_read")
    // Worktree file untouched by the rejected edit #2.
    expect(readFileSync(resolved, "utf8")).toBe("a = 2\nb = 1")
  })
})

describe("jul-13 edit-fresh-hash × mtime guard — fast-apply-merge success path", () => {
  const dir = mkdtempSync(join(tmpdir(), "fresh-hash-merge-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("advertised hash on a fast-apply-merge success is over the MERGED bytes, and the merge write also trips the default-ON guard on a chained edit", async () => {
    // When exact+fuzzy miss and `ctx.fastApplyMerge` is wired, a verified merge
    // becomes `planned.next` and flows through the SAME commit + fresh-hash path.
    // Pin: (a) the advertised hash equals sha256 of the MERGED on-disk bytes (not
    // the pre-merge source), and (b) the merge write advances mtime with no
    // record-on-write → the guard would reject a chained no-re-read edit (defeat
    // holds for the merge rung too). We supply a merge port that returns the model
    // merge for a deterministic sketch.
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
      // Deterministic merge port: the exact/fuzzy ladder misses on this old_string
      // (not present verbatim), so the merge rung runs and returns `merged`.
      fastApplyMerge: {
        async apply(_input: { original: string; editSketch: string; path?: string }) {
          return { ok: true as const, merged, rationale: "test merge" }
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
    expect(advertised).toBeDefined()
    // (a) advertised hash is over the MERGED bytes that landed on disk.
    expect(readFileSync(path, "utf8")).toBe(merged)
    expect(advertised).toBe(sha256Hex(merged))
    // red-on-injection: hashing the pre-merge source would be caught.
    expect(advertised).not.toBe(sha256Hex("alpha\nbeta\n"))

    // (b) the merge write advanced mtime; guard baseline not refreshed → a chained
    // no-re-read edit with the fresh hash is rejected stale_read (defeat unchanged
    // for the merge success path).
    const onDisk = statSync(path).mtimeMs
    expect(onDisk).toBeGreaterThan(state.recordedMtime(path) as number)
    const r2 = await runEdit(
      { path, old_string: "alpha", new_string: "ALPHA2", expected_hash: advertised },
      ctx,
    )
    expect(r2.ok).toBe(false)
    expect((r2.failure as { reason?: string } | undefined)?.reason).toBe("stale_read")
  })
})
