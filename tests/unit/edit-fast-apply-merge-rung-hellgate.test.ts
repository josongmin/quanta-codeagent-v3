/**
 * jun-7-misc 06 (ADR ≥0497) hellgate — `edit`-tool model-apply MERGE rung.
 *
 * The MERGE rung is an OPTIONAL ladder step inserted AFTER exact/fuzzy miss and
 * BEFORE the typed mismatch. It is reached ONLY when `ctx.fastApplyMerge` is
 * wired (gate ON + apply-model configured). The merged file is a PROPOSAL: it is
 * re-verified IN the edit tool and routed through the SAME gated commit +
 * diff-sink path as any edit — NEVER a blind side-channel write.
 *
 * Adversarial invariants pinned here:
 *
 *   Default-OFF byte-identity (the ratchet)
 *     EM-01 no `fastApplyMerge` on ctx ⇒ an unmatched edit returns the EXACT
 *           legacy `not_found` typed mismatch AND makes ZERO apply-model dispatch.
 *     EM-02 a NORMAL (matching) edit with the port wired never reaches the rung
 *           (zero dispatch) — the rung is recovery-only.
 *
 *   ON, correct merge ⇒ rung used, STILL gated
 *     EM-03 a fake apply model returns a correct merged file ⇒ the edit SUCCEEDS,
 *           the merged bytes are WRITTEN via the normal commit, and the tool-diff
 *           sink sees the verbatim before/after (the gated path — not a side write).
 *
 *   ON, broken/hallucinated merge ⇒ verification catches it ⇒ fail-closed
 *           (RED-ON-INJECTION — the core security test)
 *     EM-04 merge that DROPS content (empty file) ⇒ rejected ⇒ legacy mismatch,
 *           file on disk UNCHANGED.
 *     EM-05 merge that does NOT contain new_string ⇒ rejected ⇒ file UNCHANGED.
 *     EM-06 merge that still contains old_string (anchor not replaced) ⇒ rejected.
 *     EM-07 merge that INJECTS unrelated content but otherwise looks plausible:
 *           accepted ONLY through the gated commit + diff sink (never a blind
 *           write) — assert the write went through the SAME path any edit takes.
 *
 *   Provider failure ⇒ fail-closed
 *     EM-08 apply port throws ⇒ legacy mismatch, file UNCHANGED, turn survives.
 *     EM-09 apply port returns ok:false ⇒ legacy mismatch, file UNCHANGED.
 *
 *   Never-blind-write invariant
 *     EM-10 across the accept path, the ONLY write is via `fs.writeFile` (the
 *           commit) — there is NO write when verification rejects.
 */

import { describe, expect, test } from "bun:test"
import type { FileInfo, FileSystemPort } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"
import type { FastApplyMergeSeam } from "@/tool/types"

/** Recording in-memory FS: counts writes so we can prove fail-closed paths
 *  perform NO write, and the accept path writes EXACTLY once via the commit. */
const makePort = (seed: Record<string, string>) => {
  const files = new Map<string, string>(Object.entries(seed))
  const writes: Array<{ path: string; content: string }> = []
  const port: FileSystemPort = {
    async readFile(path: string): Promise<string> {
      const v = files.get(path)
      if (v === undefined) throw new Error(`File not found: ${path}`)
      return v
    },
    async writeFile(path: string, content: string): Promise<void> {
      writes.push({ path, content })
      files.set(path, content)
    },
    async statFile(path: string): Promise<FileInfo> {
      return {
        path,
        size: files.get(path)?.length ?? 0,
        isDirectory: false,
        mtimeMs: 0,
        isFIFO: false,
        isCharacterDevice: false,
        isBlockDevice: false,
      }
    },
    async fileExists(path: string): Promise<boolean> {
      return files.has(path)
    },
  }
  return { port, files, writes }
}

/** A recording apply-merge port (structural mirror of `FastApplyMergeSeam`). */
const makeMerge = (
  behavior: (input: {
    original: string
    editSketch: string
    path?: string
  }) => { ok: true; merged: string } | { ok: false } | "throw",
) => {
  const calls: Array<{ original: string; editSketch: string; path?: string }> = []
  const seam: FastApplyMergeSeam = {
    async apply(input) {
      calls.push(input)
      const b = behavior(input)
      if (b === "throw") throw new Error("apply provider exploded")
      if (!b.ok) return { ok: false, merged: null, rationale: "non-ok" }
      return { ok: true, merged: b.merged, rationale: "merged", modelUsed: "fake-apply" }
    },
  }
  return { seam, calls }
}

const ORIGINAL = "alpha\nbeta\ngamma\n"

const TEST_REVIEW_APPROVES = {
  approve: async (): Promise<boolean> => true,
}

const ctxOf = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/",
  signal: new AbortController().signal,
  // Positive merge tests exercise a host-owned review decision; production
  // contexts omit this seam unless their composition root owns the authority.
  fastApplyMergeReview: TEST_REVIEW_APPROVES,
  ...over,
})

const run = async (
  tool: {
    execute: (i: never, c: ToolContext) => AsyncIterable<{ type: string; result?: ToolResult }>
  },
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("jun-7-misc 06 edit fast-apply MERGE rung hellgate", () => {
  test("EM-01 OFF (no port) ⇒ legacy not_found mismatch, ZERO dispatch", async () => {
    const { port, files } = makePort({ "a.ts": ORIGINAL })
    const tool = makeEditTool(port)
    // No fastApplyMerge on ctx.
    const res = await run(
      tool,
      { path: "a.ts", old_string: "does-not-exist", new_string: "X" },
      ctxOf(),
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("not_found")
    // File untouched.
    expect(files.get("a.ts")).toBe(ORIGINAL)
  })

  test("EM-02 a MATCHING edit never reaches the rung (zero dispatch)", async () => {
    const { port } = makePort({ "a.ts": ORIGINAL })
    const merge = makeMerge(() => ({ ok: true, merged: "SHOULD-NOT-BE-USED" }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "beta", new_string: "BETA" },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(res.ok).toBe(true)
    expect(merge.calls).toHaveLength(0)
  })

  test("EM-02b merge without a host review seam is fail-closed before provider dispatch", async () => {
    const { port, files, writes } = makePort({ "a.ts": ORIGINAL })
    const merge = makeMerge(() => ({ ok: true, merged: "alpha\nBETA\ngamma\n" }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "beta-typo", new_string: "BETA" },
      ctxOf({ fastApplyMerge: merge.seam, fastApplyMergeReview: undefined }),
    )
    expect(res.ok).toBe(false)
    expect(merge.calls).toHaveLength(0)
    expect(writes).toHaveLength(0)
    expect(files.get("a.ts")).toBe(ORIGINAL)
  })

  test("EM-02c reviewer failure is fail-closed after proposal and before write", async () => {
    const { port, files, writes } = makePort({ "a.ts": ORIGINAL })
    const merge = makeMerge(() => ({ ok: true, merged: "alpha\nBETA\ngamma\n" }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "beta-typo", new_string: "BETA" },
      ctxOf({
        fastApplyMerge: merge.seam,
        fastApplyMergeReview: {
          approve: async () => {
            throw new Error("review authority unavailable")
          },
        },
      }),
    )
    expect(res.ok).toBe(false)
    expect(merge.calls).toHaveLength(1)
    expect(writes).toHaveLength(0)
    expect(files.get("a.ts")).toBe(ORIGINAL)
  })

  test("EM-03 ON + correct merge ⇒ written via gated commit, diff sink sees before/after", async () => {
    const { port, files, writes } = makePort({ "a.ts": ORIGINAL })
    const MERGED = "alpha\nBETA-merged\ngamma\n"
    const merge = makeMerge(() => ({ ok: true, merged: MERGED }))
    const captured: Array<{ before: string; after: string }> = []
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      // exact/fuzzy miss (anchor not literally present) → rung fires
      { path: "a.ts", old_string: "beta-typo", new_string: "BETA-merged" },
      ctxOf({
        fastApplyMerge: merge.seam,
        toolCallId: "call-1",
        toolDiff: { capture: (i) => captured.push({ before: i.before, after: i.after }) },
      }),
    )
    expect(res.ok).toBe(true)
    expect(merge.calls).toHaveLength(1)
    // The sketch was derived from old/new — passed to the apply model.
    expect(merge.calls[0]?.editSketch).toContain("BETA-merged")
    // Written via the NORMAL commit path.
    expect(writes).toHaveLength(1)
    expect(files.get("a.ts")).toBe(MERGED)
    // The post-write observation sink saw the verbatim before/after.
    expect(captured).toHaveLength(1)
    expect(captured[0]?.before).toBe(ORIGINAL)
    expect(captured[0]?.after).toBe(MERGED)
  })

  test("EM-04 RED: merge drops content (empty) ⇒ rejected, file UNCHANGED", async () => {
    const { port, files, writes } = makePort({ "a.ts": ORIGINAL })
    const merge = makeMerge(() => ({ ok: true, merged: "   \n" }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "beta-typo", new_string: "BETA" },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("not_found")
    expect(writes).toHaveLength(0)
    expect(files.get("a.ts")).toBe(ORIGINAL)
  })

  test("EM-05 RED: merge missing new_string ⇒ rejected, file UNCHANGED", async () => {
    const { port, files, writes } = makePort({ "a.ts": ORIGINAL })
    // Plausible-looking file, but it never contains the intended new text.
    const merge = makeMerge(() => ({ ok: true, merged: "alpha\nsomething-else\ngamma\n" }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "beta-typo", new_string: "BETA-INTENDED" },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(res.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(files.get("a.ts")).toBe(ORIGINAL)
  })

  test("EM-06 deterministic edit wins ⇒ rung NOT consulted when exact matches", async () => {
    const { port, writes } = makePort({ "a.ts": "keep\nREPLACE_ME\nkeep\n" })
    // A wired port that, if ever called, would inject. Assert it is NEVER called
    // because exact matched — the rung is recovery-only, never shadows a clean edit.
    const merge = makeMerge(() => ({ ok: true, merged: "keep\nINJECTED\nkeep\n" }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "REPLACE_ME", new_string: "NEWLINE" },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(merge.calls).toHaveLength(0)
    expect(res.ok).toBe(true)
    expect(writes).toHaveLength(1)
  })

  test("EM-06b RED: rung fires + merge leaves old_string ⇒ rejected, UNCHANGED", async () => {
    const FILE = "keep\nkeep2\nkeep3\n"
    const { port, files, writes } = makePort({ "a.ts": FILE })
    // old_string is NOT in the file (so exact/fuzzy MISS → the rung fires), but
    // the malicious merge re-introduces that EXACT old_string verbatim alongside
    // the new text. new_string does NOT contain old_string, so its presence in
    // the merged output means the anchor was never resolved ⇒ reject.
    const merge = makeMerge(() => ({
      ok: true,
      merged: "keep\nGHOST_OLD\nNEWTEXT\nkeep3\n", // contains old_string AND new_string
    }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "GHOST_OLD", new_string: "NEWTEXT" },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(merge.calls).toHaveLength(1)
    expect(res.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(files.get("a.ts")).toBe(FILE)
  })

  test("EM-07 INJECTED-but-plausible merge accepted ONLY via gated commit + sink", async () => {
    const { port, files, writes } = makePort({ "a.ts": ORIGINAL })
    const INJECTED = "alpha\nBETA\ngamma\n// injected by apply model\n"
    const merge = makeMerge(() => ({ ok: true, merged: INJECTED }))
    let sinkCalls = 0
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "beta-typo", new_string: "BETA" },
      ctxOf({
        fastApplyMerge: merge.seam,
        toolCallId: "c",
        toolDiff: {
          capture: () => {
            sinkCalls += 1
          },
        },
      }),
    )
    // It passes the structural gate (contains new_string, changed, old gone), so
    // it's accepted — but ONLY through the normal commit + diff sink. The whole
    // point: there is no path that writes `merged` WITHOUT the gate. The diff
    // sink (the reviewer surface) was fed, and exactly one commit write happened.
    expect(res.ok).toBe(true)
    expect(writes).toHaveLength(1)
    expect(files.get("a.ts")).toBe(INJECTED)
    expect(sinkCalls).toBe(1)
  })

  test("EM-08 provider throws ⇒ fail-closed, file UNCHANGED, turn survives", async () => {
    const { port, files, writes } = makePort({ "a.ts": ORIGINAL })
    const merge = makeMerge(() => "throw")
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "beta-typo", new_string: "BETA" },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("not_found")
    expect(writes).toHaveLength(0)
    expect(files.get("a.ts")).toBe(ORIGINAL)
  })

  test("EM-09 provider ok:false ⇒ fail-closed, file UNCHANGED", async () => {
    const { port, files, writes } = makePort({ "a.ts": ORIGINAL })
    const merge = makeMerge(() => ({ ok: false }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "beta-typo", new_string: "BETA" },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(res.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(files.get("a.ts")).toBe(ORIGINAL)
  })

  test("EM-11 RED: empty new_string ⇒ rung MUST fail-closed (no `includes('')` bypass)", async () => {
    // R1 adversarial finding. A deletion edit (new_string === "") makes the
    // edit-scoped `merged.includes(newString)` check vacuously true (every string
    // contains ""), so a hallucinated merge of ARBITRARY unrelated content would
    // pass verification and reach disk. The rung must refuse the empty-new_string
    // case entirely and fall through to the byte-identical typed mismatch.
    const { port, files, writes } = makePort({ "a.ts": ORIGINAL })
    const GARBAGE = "TOTALLY UNRELATED CONTENT INJECTED BY APPLY MODEL\n"
    const merge = makeMerge(() => ({ ok: true, merged: GARBAGE }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      // old_string absent (exact/fuzzy miss → rung path), new_string empty (deletion).
      { path: "a.ts", old_string: "beta-typo", new_string: "" },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("not_found")
    expect(writes).toHaveLength(0)
    expect(files.get("a.ts")).toBe(ORIGINAL)
  })

  test("EM-12 RED: line_ranges scoped ⇒ rung MUST NOT run (whole-file merge can't honor scope)", async () => {
    // R1 adversarial finding. When the caller restricts the edit to a bounded
    // line span, the deterministic exact/fuzzy ladder honors it. The whole-file
    // merge rung sees the ENTIRE file and a hallucinated merge can mutate lines
    // OUTSIDE the declared scope (e.g. rewriting a secret on another line) while
    // still landing new_string — a scope escape. The rung must be skipped whenever
    // line_ranges is supplied, falling through to the typed mismatch byte-identically.
    const ORIG = "line1\nSECRET_TOKEN=abc\nline3\ntarget_here\nline5\n"
    const { port, files, writes } = makePort({ "a.ts": ORIG })
    const INJECT = "line1\nSECRET_TOKEN=LEAKED\nline3\nBETA\nline5\n" // mutated line 2, OUTSIDE scope
    const merge = makeMerge(() => ({ ok: true, merged: INJECT }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      // old_string absent → exact/fuzzy miss; line_ranges restricts to line 4.
      {
        path: "a.ts",
        old_string: "absent_anchor",
        new_string: "BETA",
        line_ranges: [{ start: 4, end: 4 }],
      },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(res.ok).toBe(false)
    expect(merge.calls).toHaveLength(0)
    expect(writes).toHaveLength(0)
    expect(files.get("a.ts")).toBe(ORIG)
  })

  test("EM-13 RED: replace_all ⇒ rung MUST NOT run (whole-file merge can't prove ALL sites changed)", async () => {
    // R2 adversarial finding. `replace_all` is a deterministic contract: change
    // EVERY occurrence of old_string. A whole-file model merge sees only a terse
    // sketch and the edit-scoped verification checks single-occurrence presence/
    // absence — it CANNOT prove all N sites were changed. A merge that changes
    // only one (or the wrong) site would still pass `merged.includes(new_string)`
    // while silently violating replace_all semantics. The rung must be skipped
    // under replace_all, falling through to the typed mismatch byte-identically.
    const ORIG = "FOO\nFOO\nFOO\n"
    const { port, files, writes } = makePort({ "a.ts": ORIG })
    // A merge that changes only ONE of the three sites (partial replace_all).
    const PARTIAL = "BAR\nFOO\nFOO\n"
    const merge = makeMerge(() => ({ ok: true, merged: PARTIAL }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      // old_string absent → exact/fuzzy miss; replace_all requested.
      { path: "a.ts", old_string: "FOO_TYPO", new_string: "BAR", replace_all: true },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(res.ok).toBe(false)
    expect(merge.calls).toHaveLength(0)
    expect(writes).toHaveLength(0)
    expect(files.get("a.ts")).toBe(ORIG)
  })

  test("EM-14 content-drop proposal requires an explicit reviewer decision before write", async () => {
    // The deterministic gate cannot prove unrelated semantics were preserved:
    // the proposed new text can land in a comment while real code disappears.
    // A tool-diff sink is post-write observation, so only a pre-commit reviewer
    // may authorize this path. The reviewer below sees the exact drop and denies.
    const ORIG = "function pay(){ transfer(amount) }\nconst x = 1\nconst y = 2\n"
    const { port, writes } = makePort({ "a.ts": ORIG })
    // Intended edit: x = 1 → x = 42. The merge lands "x = 42" in a COMMENT and
    // drops the entire `function pay` line — content drop the gate can't bound.
    const DROPPED = "// note: x = 42 requested\nconst y = 2\n"
    const merge = makeMerge(() => ({ ok: true, merged: DROPPED }))
    const captured: Array<{ before: string; after: string }> = []
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "const x = 1 typo", new_string: "x = 42" },
      ctxOf({
        fastApplyMerge: merge.seam,
        toolCallId: "c",
        toolDiff: { capture: (i) => captured.push({ before: i.before, after: i.after }) },
        fastApplyMergeReview: {
          approve: async ({ before, after }) => {
            expect(before).toBe(ORIG)
            expect(after).toBe(DROPPED)
            return false
          },
        },
      }),
    )
    expect(res.ok).toBe(false)
    expect(writes).toHaveLength(0)
    // Review runs before the post-write observation sink, so denied proposals
    // are neither persisted nor misrepresented as a successful diff frame.
    expect(captured).toHaveLength(0)
  })

  test("EM-15 RED: pre-existing new_string + drop ⇒ rejected (landed-signal must be count-increase, not presence-anywhere)", async () => {
    // R3 adversarial finding. The edit-scoped "did the change land" check used
    // `merged.includes(new_string)` — true if new_string appears ANYWHERE. But
    // when new_string ALREADY exists in the original (unrelated to the edit), a
    // hallucinated merge that DROPS unrelated lines while keeping the pre-existing
    // occurrence passes that check vacuously: the edit never landed, yet real code
    // (here a SECRET line) was silently dropped and written.
    //   original: `import {BETA} ...` (already contains "BETA") + a SECRET line.
    //   edit: old_string absent (rung fires), new_string = "BETA" (pre-exists).
    //   merge: drops the SECRET line, keeps the pre-existing BETA → includes("BETA") true.
    // A SOUND landed-signal requires the new_string COUNT to strictly INCREASE
    // (the merge actually added the intended text), not merely be present. With no
    // increase AND old_string absent from the original, there is no trustworthy
    // proof the edit landed ⇒ fail-closed to the typed mismatch.
    const ORIG = "import {BETA} from 'x'\nalpha\ngamma\nSECRET_TOKEN=abc123\n"
    const { port, files, writes } = makePort({ "a.ts": ORIG })
    const DROPPED = "import {BETA} from 'x'\nalpha\ngamma\n" // SECRET line dropped; BETA pre-exists
    const merge = makeMerge(() => ({ ok: true, merged: DROPPED }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "beta_typo_absent", new_string: "BETA" },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(merge.calls).toHaveLength(1)
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("not_found")
    expect(writes).toHaveLength(0)
    expect(files.get("a.ts")).toBe(ORIG)
  })

  test("EM-16 GREEN companion: genuine landing where new_string pre-exists ⇒ accepted (count increased)", async () => {
    // Dual of EM-15: a LEGITIMATE merge where new_string also pre-exists in the
    // original but the merge actually ADDS another occurrence (count 1 → 2). The
    // strict count-increase signal must still ACCEPT this so the fix does not
    // over-reject real edits that introduce a duplicate of existing text.
    const ORIG = "import {BETA} from 'x'\nalpha\nbeta_anchor_typo_missing\ngamma\n"
    const { port, files, writes } = makePort({ "a.ts": ORIG })
    // genuine landing: the anchor region becomes "BETA" → now TWO occurrences of BETA.
    const MERGED = "import {BETA} from 'x'\nalpha\nBETA\ngamma\n"
    const merge = makeMerge(() => ({ ok: true, merged: MERGED }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "beta_anchor_typo_missing", new_string: "BETA" },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(res.ok).toBe(true)
    expect(writes).toHaveLength(1)
    expect(files.get("a.ts")).toBe(MERGED)
  })

  test("EM-17 RED: merge that COPIED the elision marker (dropped real code) ⇒ rejected, file UNCHANGED", async () => {
    // R4 adversarial finding. The merge-runner's header promises that "even a
    // runner that returned ok:true on garbage can never reach disk unverified"
    // because the CONSUMER re-verifies. But the consumer only ran
    // `verifyEditScopedMerge` (new_string present / old_string absent / changed) —
    // it did NOT re-check the elision marker the way the runner's
    // `verifyMergeStructural` does. A buggy/compromised/duck-typed port that
    // returns a merge where the apply model COPIED the `// ... existing code ...`
    // sketch verbatim instead of EXPANDING it stands the literal marker in place of
    // the dropped real lines: here `alpha` and `gamma` are GONE, replaced by the
    // marker text, while `BETA_NEW` lands (count 0→1) and the absent old_string is
    // gone — so the edit-scoped check passes and the corrupted file (real code
    // dropped, marker text written as source) reaches disk. The consumer MUST
    // reject any merge that still literally contains the elision marker it injected,
    // independent of the runner (slice isolation ⇒ the port cannot be trusted to
    // have run the structural check). Defense-in-depth, deterministic, no heuristic.
    const ORIG = "alpha\nbeta\ngamma\n"
    const { port, files, writes } = makePort({ "a.ts": ORIG })
    const MARKER_LEFTOVER = "// ... existing code ...\nBETA_NEW\n// ... existing code ..."
    const merge = makeMerge(() => ({ ok: true, merged: MARKER_LEFTOVER }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      // old_string genuinely absent → exact/fuzzy miss → rung fires.
      { path: "a.ts", old_string: "absent_anchor_typo", new_string: "BETA_NEW" },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(merge.calls).toHaveLength(1)
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("not_found")
    expect(writes).toHaveLength(0)
    expect(files.get("a.ts")).toBe(ORIG)
  })

  test("EM-18 GREEN companion: a LEGITIMATE edit whose new_string introduces the marker is NOT over-rejected", async () => {
    // Dual of EM-17. The leftover-marker guard must NOT be a blanket ban: when the
    // caller's intended `new_string` legitimately CONTAINS `// ... existing code ...`
    // (e.g. editing a Cursor-rules doc / a snippet that quotes the convention) and
    // the merge introduces it exactly that many times, the count is accounted for by
    // the new_string itself — so the merge must still be accepted. Otherwise the R4
    // guard would corrupt a real use case.
    const ORIG = "header\nbeta_absent_anchor\nfooter\n"
    const { port, files, writes } = makePort({ "a.ts": ORIG })
    // new_string genuinely embeds the marker; merge introduces exactly one marker
    // (attributable to new_string), drops nothing.
    const NEW = "// ... existing code ... (quoted in a doc)"
    const MERGED = `header\n${NEW}\nfooter\n`
    const merge = makeMerge(() => ({ ok: true, merged: MERGED }))
    const tool = makeEditTool(port)
    const res = await run(
      tool,
      { path: "a.ts", old_string: "beta_absent_anchor", new_string: NEW },
      ctxOf({ fastApplyMerge: merge.seam }),
    )
    expect(res.ok).toBe(true)
    expect(writes).toHaveLength(1)
    expect(files.get("a.ts")).toBe(MERGED)
  })

  test("EM-10 never-blind-write: rejected merges produce ZERO writes", async () => {
    for (const behavior of [
      () => ({ ok: true as const, merged: "   " }), // empty
      () => ({ ok: true as const, merged: "no new text here" }), // missing new_string
      () => ({ ok: false as const }), // provider non-ok
      () => "throw" as const, // provider throw
    ]) {
      const { port, files, writes } = makePort({ "a.ts": ORIGINAL })
      const merge = makeMerge(behavior)
      const tool = makeEditTool(port)
      await run(
        tool,
        { path: "a.ts", old_string: "beta-typo", new_string: "BETA-INTENDED" },
        ctxOf({ fastApplyMerge: merge.seam }),
      )
      expect(writes).toHaveLength(0)
      expect(files.get("a.ts")).toBe(ORIGINAL)
    }
  })
})
