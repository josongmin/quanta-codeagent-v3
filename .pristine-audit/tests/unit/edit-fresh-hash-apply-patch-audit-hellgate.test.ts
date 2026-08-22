/** jul-13 ADVERSARIAL hell-audit — apply_patch × edit-fresh-hash baseline
 *  refresh, the UNTESTED reachable paths the sibling
 *  `tests/unit/edit-fresh-hash-apply-patch-hellgate.test.ts` LEAVES OPEN.
 *
 *  That sibling drives `applyPatchTool` with NO `ctx.fastApplyFallback` wired,
 *  so every one of its 6 tests takes SUCCESS SITE (1) in `execute` — the
 *  no-fallback fast path (`if (fallback === undefined)`). `refreshApplyBaselines`
 *  is ALSO called at two OTHER success `yield` sites the sibling never reaches:
 *
 *    (2) the fallback-TRY success (fallback wired, the primary apply succeeded
 *        first-try so the fallback is never consulted), and
 *    (3) the FAST-APPLY FALLBACK RESCUE path — the `catch (err)` branch where a
 *        RECOVERABLE V4A failure is re-emitted by `ctx.fastApplyFallback` and the
 *        retry succeeds. THIS is the primary suspected hole: if the site-3
 *        refresh were missing/broken, a chained no-re-read edit after a
 *        fast-apply-recovered patch would silently `stale_read` and NO existing
 *        test would catch it (the wire test never wires `readFileState`, the
 *        fresh-hash test never wires the fallback).
 *
 *  WHAT THIS FILE PINS (all against a REAL tmpdir fs + a REAL `ReadFileState`
 *  wired exactly as production, Home-bonus ZERO, mutation-resistant):
 *
 *    A. SITE-3 RESCUE REFRESH (the primary gap) — a recoverable V4A failure is
 *       rescued by the fallback; the recovered file's baseline == its
 *       POST-COMMIT on-disk mtime, AND a chained no-re-read edit to it SURVIVES
 *       the DEFAULT-ON guard (no stale_read). PROVES site-3 refresh ran.
 *    B. SITE-3 PAIRED CONTROL / RED-ON-INJECTION — the SAME rescue with
 *       editFreshHash OFF ⇒ the chained edit FAILS stale_read. This is the
 *       non-vacuity proof: (i) test A succeeds ONLY because of the site-3
 *       refresh, and (ii) BOTH tests actually reach the rescue branch (the
 *       fallback's `attempt` is invoked exactly once + the output notes
 *       "fast-apply"), so this is genuinely site 3, NOT site 1.
 *    C. SITE-2 REFRESH (fallback wired but primary succeeds first-try) — the
 *       fallback is NEVER consulted, yet the refresh still runs; a chained edit
 *       survives. Distinguishes site-2 from site-1 (fallback present) and from
 *       site-3 (no rescue). Paired control mirror included.
 *    D. MOVE-SOURCE stale baseline (behavior pin) — after a move, the moved-away
 *       `from` path keeps its STALE read-time baseline (refresh records only the
 *       `to` destination). A later apply_patch that references `from` as an
 *       UPDATE target does NOT stale-block (the file is gone ⇒ `statTarget`
 *       says not-present ⇒ the guard skips it) — it fails with the applier's own
 *       missing-target error instead. Benign, pinned so a regression is visible.
 *    E. DELETE-ONLY patch — `touched` is empty ⇒ the refresh loops ZERO times,
 *       no crash, and the deleted file's baseline is left untouched (a deleted
 *       file cannot be chain-edited). Pins the no-touched-file no-op.
 *    F. CANONICAL PATH IDENTITY under path-form stress — apply_patch via a
 *       RELATIVE path in the patch, then a chained edit via the ABSOLUTE path:
 *       the recorded baseline (keyed on the canonical resolved abs path) still
 *       matches the edit's guardWrite key ⇒ the chain survives. Proves the
 *       byte-for-byte path identity `refreshApplyBaselines` documents.
 *
 *  This file does NOT touch any existing test file or any src file. */

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  FastApplyAttemptResult,
  FastApplyFailure,
  FastApplyFallbackPort,
} from "@/agent/fast-apply-fallback"
import { defaultFileSystemPort } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { applyPatchTool } from "@/tool/apply-patch"
import { makeEditTool } from "@/tool/edit"
import { ReadFileState } from "@/tool/stale-read-guard"

const FRESH_RE = /fresh sha256: [0-9a-f]{64}/

/** Production-faithful ctx: DEFAULT-ON stale-read guard (a live `ReadFileState`)
 *  + optional `fastApplyFallback` + `editFreshHash` toggle. Omitting the flag
 *  models `QUANTA_EDIT_FRESH_HASH=off` (ctx.editFreshHash absent) — the gating
 *  paired control. The fallback seam is passed structurally (the wire hellgate
 *  does the same: a `FastApplyFallbackPort` satisfies `FastApplyFallbackSeam`). */
const prodCtx = (opts: {
  cwd: string
  state: ReadFileState
  freshHash: boolean
  fallback?: FastApplyFallbackPort
  signal?: AbortSignal
}): ToolContext => ({
  cwd: opts.cwd,
  signal: opts.signal ?? new AbortController().signal,
  readFileState: opts.state,
  ...(opts.freshHash ? { editFreshHash: true } : {}),
  ...(opts.fallback !== undefined ? { fastApplyFallback: opts.fallback } : {}),
})

/** Records every `attempt` so a test can assert the rescue branch was actually
 *  reached (exactly-once), then re-emit a supplied fixed patch. */
interface FakeFallback extends FastApplyFallbackPort {
  readonly calls: FastApplyFailure[]
}
const makeFallback = (
  behaviour: (input: { failure: FastApplyFailure }) => FastApplyAttemptResult,
): FakeFallback => {
  const calls: FastApplyFailure[] = []
  return {
    calls,
    async attempt(input, signal): Promise<FastApplyAttemptResult> {
      calls.push(input.failure)
      if (signal?.aborted === true) return { ok: false, newPatch: null, rationale: "aborted" }
      return behaviour({ failure: input.failure })
    },
  }
}

const runApply = async (patch: string, ctx: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of applyPatchTool.execute({ patch } as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("apply_patch: no result")
  return result
}
/** Capture EITHER the terminal result OR the thrown error (the rescue-fail /
 *  missing-target paths throw the ORIGINAL typed error out of the generator). */
const runApplyOrThrow = async (
  patch: string,
  ctx: ToolContext,
): Promise<{ result: ToolResult } | { error: unknown }> => {
  try {
    return { result: await runApply(patch, ctx) }
  } catch (error) {
    return { error }
  }
}

const runEdit = async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of makeEditTool(defaultFileSystemPort).execute(input as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("edit: no result")
  return result
}

/** Model the `read` tool exactly: stat, record RESOLVED abs path + mtimeMs. */
const recordReadTimeMtime = (state: ReadFileState, absPath: string): number => {
  const m = statSync(absPath).mtimeMs
  state.record(absPath, m)
  return m
}

const ORIGINAL = "alpha\nbeta\ngamma\ndelta\nepsilon\n"
const PATCHED = "alpha\nbeta\nGAMMA\ndelta\nepsilon\n"

/** A patch whose anchor context (`not-present`) does NOT exist in the target ⇒
 *  a RECOVERABLE `PatchAnchorNotFoundError` (errorKind `anchor_not_found`), the
 *  exact recoverable failure class the fast-apply fallback exists to rescue. */
const driftPatch = (relFile: string): string =>
  [
    "*** Begin Patch",
    `*** Update File: ${relFile}`,
    "@@",
    " unrelated context",
    "-not-present",
    "+replacement",
    "*** End Patch",
  ].join("\n")

/** The CORRECT `gamma`→`GAMMA` patch the fake fallback "re-emits" to rescue the
 *  drift above. Applying it advances the file's mtime — the very thing the
 *  site-3 refresh must re-record. */
const fixedPatch = (relFile: string): string =>
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

describe("jul-13 apply_patch × edit-fresh-hash AUDIT — untested success sites (real fs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "apply-fresh-hash-audit-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // =========================================================================
  // A. SITE-3 FAST-APPLY RESCUE REFRESH — the PRIMARY hole.
  // =========================================================================
  test("A. SITE-3 rescue: recoverable drift → fallback re-emit → recovered file baseline == post-commit mtime → chained no-re-read edit SURVIVES", async () => {
    const rel = "rescue.txt"
    const path = join(dir, rel)
    writeFileSync(path, ORIGINAL, "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const fb = makeFallback(() => ({
      ok: true,
      newPatch: fixedPatch(rel),
      rationale: "re-emitted",
      modelUsed: "gpt-fast",
    }))
    const ctx = prodCtx({ cwd: dir, state, freshHash: true, fallback: fb })

    // Primary apply THROWS anchor_not_found → caught → fallback rescues via the
    // fixed patch → the tool yields success at SITE 3.
    const r1 = await runApply(driftPatch(rel), ctx)
    expect(r1.ok).toBe(true)
    // Proof we reached the RESCUE branch (site 3), not the first-try path:
    expect(fb.calls.length).toBe(1) // fallback consulted exactly once
    expect(fb.calls[0]?.errorKind).toBe("anchor_not_found")
    expect(r1.output.toLowerCase()).toContain("fast-apply") // rescue note present
    // The rescue actually applied the FIXED patch:
    expect(readFileSync(path, "utf8")).toBe(PATCHED)

    // THE SITE-3 REFRESH RAN: the recovered file's baseline == post-commit mtime.
    // (Reverting the site-3 `refreshApplyBaselines` call flips this RED.)
    expect(state.recordedMtime(path)).toBe(statSync(path).mtimeMs)

    // And the whole point: a chained no-re-read edit to the recovered file
    // survives the DEFAULT-ON mtime guard — no spurious stale_read.
    const r2 = await runEdit({ path, old_string: "GAMMA", new_string: "GAMMA2" }, ctx)
    expect(r2.ok).toBe(true)
    expect(r2.failure).toBeUndefined()
    expect(readFileSync(path, "utf8")).toBe("alpha\nbeta\nGAMMA2\ndelta\nepsilon\n")
  })

  // =========================================================================
  // B. SITE-3 PAIRED CONTROL / RED-ON-INJECTION — flag OFF ⇒ chained edit stale.
  // =========================================================================
  test("B. SITE-3 paired control: SAME rescue with editFreshHash OFF ⇒ no refresh ⇒ chained no-re-read edit FAILS stale_read (site-3, not site-1)", async () => {
    const rel = "rescue-off.txt"
    const path = join(dir, rel)
    writeFileSync(path, ORIGINAL, "utf8")
    const state = new ReadFileState()
    const readTimeMtime = recordReadTimeMtime(state, path)
    const fb = makeFallback(() => ({
      ok: true,
      newPatch: fixedPatch(rel),
      rationale: "re-emitted",
    }))
    // ONLY difference vs test A: editFreshHash OFF. The guard + fallback are
    // wired identically, isolating the site-3 refresh as the sole variable.
    const ctx = prodCtx({ cwd: dir, state, freshHash: false, fallback: fb })

    const r1 = await runApply(driftPatch(rel), ctx)
    expect(r1.ok).toBe(true)
    // Still genuinely the RESCUE branch (site 3) — same proof as test A.
    expect(fb.calls.length).toBe(1)
    expect(r1.output.toLowerCase()).toContain("fast-apply")
    expect(readFileSync(path, "utf8")).toBe(PATCHED)

    // OFF ⇒ site-3 refresh is a no-op: baseline still the pre-patch read-time
    // mtime, while the rescue advanced the on-disk mtime past it.
    expect(state.recordedMtime(path)).toBe(readTimeMtime)
    expect(statSync(path).mtimeMs).toBeGreaterThan(readTimeMtime)

    // The chained no-re-read edit is vetoed stale_read — proving the site-3
    // refresh (present in test A) is exactly what cures it.
    const r2 = await runEdit({ path, old_string: "GAMMA", new_string: "GAMMA2" }, ctx)
    expect(r2.ok).toBe(false)
    expect(r2.failure?.mode).toBe("rejected")
    expect((r2.failure as { reason?: string } | undefined)?.reason).toBe("stale_read")
    expect(readFileSync(path, "utf8")).toBe(PATCHED) // rejected edit never landed
  })

  // =========================================================================
  // C. SITE-2 REFRESH — fallback WIRED but primary succeeds first-try.
  // =========================================================================
  test("C. SITE-2: fallback wired but primary apply succeeds first-try (fallback NEVER consulted) ⇒ refresh still runs ⇒ chained edit survives", async () => {
    const rel = "site2.txt"
    const path = join(dir, rel)
    writeFileSync(path, ORIGINAL, "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const fb = makeFallback(() => {
      throw new Error("fallback must NOT be consulted on a first-try success")
    })
    const ctx = prodCtx({ cwd: dir, state, freshHash: true, fallback: fb })

    // A CORRECT patch ⇒ the try-branch apply succeeds ⇒ site-2 yield; the
    // fallback is never touched (attempt count 0), yet the refresh must run.
    const r1 = await runApply(fixedPatch(rel), ctx)
    expect(r1.ok).toBe(true)
    expect(fb.calls.length).toBe(0) // proof: site 2, not site 3
    expect(r1.output.toLowerCase()).not.toContain("fast-apply") // no rescue note
    expect(readFileSync(path, "utf8")).toBe(PATCHED)

    // Site-2 refresh landed.
    expect(state.recordedMtime(path)).toBe(statSync(path).mtimeMs)
    const r2 = await runEdit({ path, old_string: "GAMMA", new_string: "GAMMA2" }, ctx)
    expect(r2.ok).toBe(true)
    expect(r2.failure).toBeUndefined()
  })

  test("C-control. SITE-2 paired control: fallback wired, flag OFF ⇒ no refresh ⇒ chained edit FAILS stale_read", async () => {
    const rel = "site2-off.txt"
    const path = join(dir, rel)
    writeFileSync(path, ORIGINAL, "utf8")
    const state = new ReadFileState()
    const readTimeMtime = recordReadTimeMtime(state, path)
    const fb = makeFallback(() => {
      throw new Error("fallback must NOT be consulted on a first-try success")
    })
    const ctx = prodCtx({ cwd: dir, state, freshHash: false, fallback: fb })

    const r1 = await runApply(fixedPatch(rel), ctx)
    expect(r1.ok).toBe(true)
    expect(fb.calls.length).toBe(0)
    expect(state.recordedMtime(path)).toBe(readTimeMtime) // OFF ⇒ untouched
    expect(statSync(path).mtimeMs).toBeGreaterThan(readTimeMtime)

    const r2 = await runEdit({ path, old_string: "GAMMA", new_string: "GAMMA2" }, ctx)
    expect(r2.ok).toBe(false)
    expect((r2.failure as { reason?: string } | undefined)?.reason).toBe("stale_read")
  })

  // =========================================================================
  // D. MOVE-SOURCE stale baseline — behavior pin (benign).
  // =========================================================================
  test("D. MOVE-SOURCE: after a move the moved-away `from` keeps its stale baseline, but a later patch referencing `from` does NOT stale-block (file gone ⇒ applier missing-target error, not stale_read)", async () => {
    const relFrom = "d-from.txt"
    const relTo = "d-to.txt"
    const from = join(dir, relFrom)
    const to = join(dir, relTo)
    writeFileSync(from, ORIGINAL, "utf8")
    const state = new ReadFileState()
    const fromReadMtime = recordReadTimeMtime(state, from) // model read the SOURCE
    const ctx = prodCtx({ cwd: dir, state, freshHash: true })

    const movePatch = [
      "*** Begin Patch",
      `*** Update File: ${relFrom}`,
      `*** Move to: ${relTo}`,
      "@@",
      " beta",
      "-gamma",
      "+GAMMA",
      " delta",
      "*** End Patch",
    ].join("\n")
    const r1 = await runApply(movePatch, ctx)
    expect(r1.ok).toBe(true)
    expect(existsSync(from)).toBe(false) // moved away
    expect(readFileSync(to, "utf8")).toBe(PATCHED)

    // The destination baseline was refreshed (site-1 refresh records `to`)...
    expect(state.recordedMtime(to)).toBe(statSync(to).mtimeMs)
    // ...but the moved-away SOURCE keeps its STALE pre-move read-time baseline
    // (refresh never records `from`; nobody cleared it).
    expect(state.recordedMtime(from)).toBe(fromReadMtime)

    // A LATER patch that tries to UPDATE the now-missing `from` does NOT trip
    // the stale-read guard on that stale baseline: `statTarget(from)` sees no
    // file ⇒ `guardStaleTargets` skips it ⇒ the applier surfaces its OWN typed
    // missing-target error (PatchApplyError / anchor). It is NOT a stale_read
    // deny (which would be a `{ result }` with failure.reason). Pin the shape.
    const secondPatch = fixedPatch(relFrom) // targets the vanished `from`
    const outcome = await runApplyOrThrow(secondPatch, ctx)
    if ("error" in outcome) {
      // Threw the applier's own typed error — NOT a stale_read deny. Good.
      expect(outcome.error).toBeInstanceOf(Error)
      expect((outcome.error as Error).name).not.toBe("StaleReadError")
    } else {
      // If it surfaced a result, it must NOT be a stale_read rejection.
      expect((outcome.result.failure as { reason?: string } | undefined)?.reason).not.toBe(
        "stale_read",
      )
    }
  })

  // =========================================================================
  // E. DELETE-ONLY patch — touched is empty ⇒ refresh is a no-op, no crash.
  // =========================================================================
  test("E. DELETE-ONLY: no ADDED/UPDATED/MOVED-to files ⇒ refresh loops zero times, no crash; deleted file's baseline is left untouched", async () => {
    const rel = "e-doomed.txt"
    const path = join(dir, rel)
    writeFileSync(path, ORIGINAL, "utf8")
    const state = new ReadFileState()
    const readMtime = recordReadTimeMtime(state, path) // model read it to decide delete
    const ctx = prodCtx({ cwd: dir, state, freshHash: true })

    const delPatch = ["*** Begin Patch", `*** Delete File: ${rel}`, "*** End Patch"].join("\n")
    const r1 = await runApply(delPatch, ctx)
    expect(r1.ok).toBe(true)
    expect(r1.output).toContain("deleted") // deletion happened
    expect(existsSync(path)).toBe(false)

    // `touched` = [] ⇒ the refresh loop ran zero iterations and did not throw.
    // The deleted file's baseline is left at its pre-delete read-time value
    // (deleted files are moot — you cannot chain-edit a file that is gone).
    expect(state.recordedMtime(path)).toBe(readMtime)
  })

  test("E-noemit. DELETE-ONLY output carries NO `fresh sha256` (apply_patch never emits)", async () => {
    const rel = "e-doomed2.txt"
    const path = join(dir, rel)
    writeFileSync(path, ORIGINAL, "utf8")
    const state = new ReadFileState()
    recordReadTimeMtime(state, path)
    const ctx = prodCtx({ cwd: dir, state, freshHash: true })
    const r = await runApply(
      ["*** Begin Patch", `*** Delete File: ${rel}`, "*** End Patch"].join("\n"),
      ctx,
    )
    expect(r.ok).toBe(true)
    expect(r.output ?? "").not.toMatch(FRESH_RE)
  })

  // =========================================================================
  // F. CANONICAL PATH IDENTITY under path-form stress.
  // =========================================================================
  test("F. PATH IDENTITY: apply_patch via RELATIVE path, chained edit via ABSOLUTE path ⇒ baseline (canonical abs key) matches the edit's guardWrite key ⇒ chain survives", async () => {
    const rel = "f-canon.txt"
    const abs = join(dir, rel)
    writeFileSync(abs, ORIGINAL, "utf8")
    const state = new ReadFileState()
    // Read-record under the ABSOLUTE path (what the read tool resolves to).
    recordReadTimeMtime(state, abs)
    const ctx = prodCtx({ cwd: dir, state, freshHash: true })

    // The patch names the file RELATIVELY; apply resolves it through the jail to
    // the canonical ABSOLUTE path and records the refreshed baseline under THAT.
    const r1 = await runApply(fixedPatch(rel), ctx)
    expect(r1.ok).toBe(true)
    expect(readFileSync(abs, "utf8")).toBe(PATCHED)
    // The refresh keyed on the canonical abs path — the SAME key the edit uses.
    expect(state.recordedMtime(abs)).toBe(statSync(abs).mtimeMs)

    // Chained edit addresses the file via the ABSOLUTE path (a different string
    // form than the patch's relative name). It survives ⇒ byte-for-byte path
    // identity between the apply refresh key and the edit's guardWrite key holds.
    const r2 = await runEdit({ path: abs, old_string: "GAMMA", new_string: "GAMMA2" }, ctx)
    expect(r2.ok).toBe(true)
    expect(r2.failure).toBeUndefined()
    expect(readFileSync(abs, "utf8")).toBe("alpha\nbeta\nGAMMA2\ndelta\nepsilon\n")
  })
})
