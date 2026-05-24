/**
 * Hellgate — ADR-0152 `applyWorkspaceEdit` 2-phase commit atomicity.
 *
 * ADR-0143 shipped per-file sequential write (mid-way failure = partial state).
 * ADR-0152 replaces that with tmp+rename 2-phase commit:
 *   Phase 0 — best-effort cleanup of leftover `<file>.quanta-tmp-<sid>-*`.
 *   Phase 1 — write all docs to sibling tmp files; rollback all on any failure.
 *   Phase 2 — POSIX `rename(tmp, target)` per file (atomic on same FS).
 *
 * Sealed slices (10+ NEW cases over the 4 in lsp-real-adapters-hellgate):
 *   A. Happy 2-phase (3)              — multi-file commit / atomic replace / mid-test tmp visibility
 *   B. Phase 1 failure → rollback (3) — fail file 2 of 3 / fail 1 of 1 / Phase 2 fail mid-rename
 *   C. Concurrent (2)                 — distinct sessionIds / same-sessionId random suffix
 *   D. Cleanup (2)                    — pre-existing stale tmp swept / no-op when clean
 */

import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import { LspClient, type LspClientOptions, type LspClientSpec } from "@/lsp"

/* ------------------------------------------------------------------ */
/* harness — same posture as lsp-real-adapters-hellgate but ADR-0152  */
/* aware (renameFile / unlinkTmp / listDir overrides).                */
/* ------------------------------------------------------------------ */

class FakeLspClient extends LspClient {
  readonly writes: { path: string; text: string }[] = []
  readonly renames: { from: string; to: string }[] = []
  readonly unlinks: string[] = []
  readonly listed: string[] = []
  private files = new Map<string, string>()
  private writeShouldThrow: ((path: string, callIdx: number) => Error | null) | null = null
  private renameShouldThrow: ((from: string, to: string, callIdx: number) => Error | null) | null =
    null
  private dirEntries = new Map<string, string[]>()
  private writeCallIdx = 0
  private renameCallIdx = 0
  /** Hook fired right before each Phase-2 rename — lets a test peek tmp state. */
  private onBeforeRename: ((from: string, to: string) => void) | null = null

  constructor(options: LspClientOptions = {}) {
    const spec: LspClientSpec = { defaultCommand: ["unused"], languageIdFor: () => "typescript" }
    super(spec, options)
  }

  setFile(path: string, text: string): void {
    this.files.set(path, text)
  }
  setWriteThrow(fn: (path: string, callIdx: number) => Error | null): void {
    this.writeShouldThrow = fn
  }
  setRenameThrow(fn: (from: string, to: string, callIdx: number) => Error | null): void {
    this.renameShouldThrow = fn
  }
  setDirEntries(dir: string, entries: string[]): void {
    this.dirEntries.set(dir, entries)
  }
  setBeforeRename(fn: (from: string, to: string) => void): void {
    this.onBeforeRename = fn
  }
  /** Post-commit on-disk state (target → final text). Mirrors what the real FS
   *  has after Phase 2 — what the user actually sees. */
  get committed(): Map<string, string> {
    const out = new Map<string, string>()
    for (const r of this.renames) {
      const w = this.writes.find((x) => x.path === r.from)
      if (w) out.set(r.to, w.text)
    }
    return out
  }
  /** Tmp files written in Phase 1 but neither renamed nor unlinked. */
  get pendingTmps(): string[] {
    const renamed = new Set(this.renames.map((r) => r.from))
    const unlinked = new Set(this.unlinks)
    return this.writes.map((w) => w.path).filter((p) => !renamed.has(p) && !unlinked.has(p))
  }

  override async start(): Promise<void> {
    return
  }
  protected override readFileText(filePath: string): Promise<string> {
    return Promise.resolve(this.files.get(filePath) ?? "")
  }
  protected override writeFileText(filePath: string, text: string): Promise<unknown> {
    const idx = this.writeCallIdx++
    if (this.writeShouldThrow) {
      const err = this.writeShouldThrow(filePath, idx)
      if (err) return Promise.reject(err)
    }
    this.writes.push({ path: filePath, text })
    return Promise.resolve(text.length)
  }
  protected override renameFile(from: string, to: string): Promise<void> {
    const idx = this.renameCallIdx++
    if (this.onBeforeRename) this.onBeforeRename(from, to)
    if (this.renameShouldThrow) {
      const err = this.renameShouldThrow(from, to, idx)
      if (err) return Promise.reject(err)
    }
    this.renames.push({ from, to })
    return Promise.resolve()
  }
  protected override unlinkTmp(filePath: string): Promise<void> {
    this.unlinks.push(filePath)
    return Promise.resolve()
  }
  protected override listDir(dir: string): Promise<string[]> {
    this.listed.push(dir)
    return Promise.resolve(this.dirEntries.get(dir) ?? [])
  }
}

const r = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
})

const TMP_MARKER = /\.quanta-tmp-[0-9a-f]+-[0-9a-f]+$/

/* ------------------------------------------------------------------ */
/* A. Happy 2-phase                                                    */
/* ------------------------------------------------------------------ */

describe("applyWorkspaceEdit — Happy 2-phase (ADR-0152)", () => {
  test("HELL-ATOM-A1: 3-file edit succeeds → all 3 originals committed; no tmps remain", async () => {
    const c = new FakeLspClient()
    const paths = ["/tmp/proj/a.ts", "/tmp/proj/b.ts", "/tmp/proj/c.ts"]
    for (const p of paths) c.setFile(p, "old\n")
    await c.applyWorkspaceEdit({
      changes: paths.map((p) => ({
        uri: pathToFileURL(p).href,
        edits: [{ range: r(0, 0, 0, 3), newText: "NEW" }],
      })),
    })
    expect(c.writes).toHaveLength(3)
    expect(c.renames).toHaveLength(3)
    for (const p of paths) expect(c.committed.get(p)).toBe("NEW\n")
    expect(c.pendingTmps).toEqual([])
    // Every Phase-1 write went to a tmp file (suffix matches scheme), Phase-2
    // committed to the originals.
    for (const w of c.writes) expect(w.path).toMatch(TMP_MARKER)
    for (const ren of c.renames) {
      expect(ren.from).toMatch(TMP_MARKER)
      expect(ren.to).not.toMatch(TMP_MARKER)
    }
  })

  test("HELL-ATOM-A2: existing originals get replaced atomically (commit-only visibility)", async () => {
    const c = new FakeLspClient()
    const a = "/tmp/proj/exists.ts"
    c.setFile(a, "before\n")
    // Mid-Phase-1 peek: the original is still untouched (writes go to tmp).
    let originalMidPhase1: string | undefined
    c.setWriteThrow((path) => {
      // Probe the "original" state right after the tmp write.
      if (path.includes(".quanta-tmp-")) {
        originalMidPhase1 = c.committed.get(a) // committed is empty mid-Phase-1
      }
      return null
    })
    await c.applyWorkspaceEdit({
      changes: [
        {
          uri: pathToFileURL(a).href,
          edits: [{ range: r(0, 0, 0, 6), newText: "after" }],
        },
      ],
    })
    expect(originalMidPhase1).toBeUndefined() // no commit yet during Phase 1
    expect(c.committed.get(a)).toBe("after\n") // commit happened after rename
  })

  test("HELL-ATOM-A3: Phase 1 tmps visible until Phase 2 rename clears them", async () => {
    const c = new FakeLspClient()
    const a = "/tmp/proj/peek.ts"
    c.setFile(a, "x\n")
    let tmpsDuringPhase2: string[] = []
    c.setBeforeRename(() => {
      // Right before the first rename: the tmp is on disk (in `writes`)
      // and not yet in `renames` → pendingTmps non-empty.
      tmpsDuringPhase2 = c.pendingTmps
    })
    await c.applyWorkspaceEdit({
      changes: [
        {
          uri: pathToFileURL(a).href,
          edits: [{ range: r(0, 0, 0, 1), newText: "Y" }],
        },
      ],
    })
    expect(tmpsDuringPhase2).toHaveLength(1)
    expect(tmpsDuringPhase2[0]).toMatch(TMP_MARKER)
    // After Phase 2 completes, no pending tmps remain.
    expect(c.pendingTmps).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* B. Phase 1 failure → rollback                                       */
/* ------------------------------------------------------------------ */

describe("applyWorkspaceEdit — Phase 1 rollback (ADR-0152)", () => {
  test("HELL-ATOM-B1: Phase 1 fails on file 2 of 3 → originals untouched, file-1 tmp unlinked", async () => {
    const c = new FakeLspClient()
    const paths = ["/tmp/proj/p1.ts", "/tmp/proj/p2.ts", "/tmp/proj/p3.ts"]
    for (const p of paths) c.setFile(p, "v0\n")
    let writeCount = 0
    c.setWriteThrow(() => {
      writeCount++
      // Throw on the SECOND Phase-1 write (file p2).
      return writeCount === 2 ? new Error("io error on file 2") : null
    })
    await expect(
      c.applyWorkspaceEdit({
        changes: paths.map((p) => ({
          uri: pathToFileURL(p).href,
          edits: [{ range: r(0, 0, 0, 2), newText: "V1" }],
        })),
      }),
    ).rejects.toThrow(/io error on file 2/)
    expect(c.renames).toHaveLength(0)
    expect(c.committed.size).toBe(0)
    // File-1's tmp was prepared then unlinked in the rollback.
    expect(c.writes).toHaveLength(1)
    expect(c.unlinks).toHaveLength(1)
    expect(c.unlinks[0]).toBe(c.writes[0]?.path)
    expect(c.pendingTmps).toEqual([])
  })

  test("HELL-ATOM-B2: Phase 1 fails on file 1 of 1 → no tmps remain, no writes recorded", async () => {
    const c = new FakeLspClient()
    const a = "/tmp/proj/only.ts"
    c.setFile(a, "orig\n")
    c.setWriteThrow(() => new Error("immediate fail"))
    await expect(
      c.applyWorkspaceEdit({
        changes: [{ uri: pathToFileURL(a).href, edits: [{ range: r(0, 0, 0, 4), newText: "X" }] }],
      }),
    ).rejects.toThrow(/immediate fail/)
    expect(c.writes).toHaveLength(0) // write threw before recording
    expect(c.renames).toHaveLength(0)
    expect(c.unlinks).toHaveLength(0) // nothing to roll back
    expect(c.pendingTmps).toEqual([])
  })

  test("HELL-ATOM-B3: Phase 2 fails on file 2 of 3 → file 1 committed, file 2+3 tmps remain, typed error", async () => {
    const c = new FakeLspClient()
    const paths = ["/tmp/proj/r1.ts", "/tmp/proj/r2.ts", "/tmp/proj/r3.ts"]
    for (const p of paths) c.setFile(p, "old\n")
    c.setRenameThrow((_from, _to, idx) => (idx === 1 ? new Error("rename EXDEV") : null))
    await expect(
      c.applyWorkspaceEdit({
        changes: paths.map((p) => ({
          uri: pathToFileURL(p).href,
          edits: [{ range: r(0, 0, 0, 3), newText: "NEW" }],
        })),
      }),
    ).rejects.toThrow(/Phase 2.*r2\.ts.*1\/3 files renamed.*2 tmp file\(s\) remain.*rename EXDEV/)
    // File 1 successfully committed.
    expect(c.renames).toHaveLength(1)
    expect(c.committed.get(paths[0] as string)).toBe("NEW\n")
    // Files 2 + 3 still have their tmps on disk (caller can recover).
    expect(c.pendingTmps).toHaveLength(2)
  })
})

/* ------------------------------------------------------------------ */
/* C. Concurrent                                                       */
/* ------------------------------------------------------------------ */

describe("applyWorkspaceEdit — Concurrency (ADR-0152)", () => {
  test("HELL-ATOM-C1: parallel edits on different files w/ different sessionIds → no interference", async () => {
    const c1 = new FakeLspClient()
    const c2 = new FakeLspClient()
    const a = "/tmp/proj/parA.ts"
    const b = "/tmp/proj/parB.ts"
    c1.setFile(a, "AA\n")
    c2.setFile(b, "BB\n")
    await Promise.all([
      c1.applyWorkspaceEdit(
        {
          changes: [
            { uri: pathToFileURL(a).href, edits: [{ range: r(0, 0, 0, 2), newText: "aa" }] },
          ],
        },
        "session-1111",
      ),
      c2.applyWorkspaceEdit(
        {
          changes: [
            { uri: pathToFileURL(b).href, edits: [{ range: r(0, 0, 0, 2), newText: "bb" }] },
          ],
        },
        "session-2222",
      ),
    ])
    expect(c1.committed.get(a)).toBe("aa\n")
    expect(c2.committed.get(b)).toBe("bb\n")
    // sessionIds are baked into the tmp suffix so concurrent ops never collide.
    expect(c1.writes[0]?.path).toContain("session-1111")
    expect(c2.writes[0]?.path).toContain("session-2222")
  })

  test("HELL-ATOM-C2: parallel edits on SAME file w/ same sessionId → random suffix prevents tmp collision", async () => {
    const c = new FakeLspClient()
    const a = "/tmp/proj/sameFile.ts"
    c.setFile(a, "Z\n")
    // Both ops use the SAME sessionId; the random hex suffix is what stops
    // them from clobbering each other's Phase-1 tmp.
    await Promise.all([
      c.applyWorkspaceEdit(
        {
          changes: [
            { uri: pathToFileURL(a).href, edits: [{ range: r(0, 0, 0, 1), newText: "P" }] },
          ],
        },
        "shared-sid",
      ),
      c.applyWorkspaceEdit(
        {
          changes: [
            { uri: pathToFileURL(a).href, edits: [{ range: r(0, 0, 0, 1), newText: "Q" }] },
          ],
        },
        "shared-sid",
      ),
    ])
    // Both produced their own tmp (distinct random suffixes), both renamed.
    expect(c.writes).toHaveLength(2)
    expect(c.writes[0]?.path).not.toBe(c.writes[1]?.path)
    expect(c.renames).toHaveLength(2)
  })
})

/* ------------------------------------------------------------------ */
/* D. Cleanup                                                          */
/* ------------------------------------------------------------------ */

describe("applyWorkspaceEdit — Phase 0 cleanup (ADR-0152)", () => {
  test("HELL-ATOM-D1: pre-existing stale tmp from same sessionId → swept before Phase 1", async () => {
    const c = new FakeLspClient()
    const a = "/tmp/proj/clean.ts"
    c.setFile(a, "x\n")
    // Pre-seed the dir listing with a stale tmp from a prior failed run with
    // the same sessionId.
    c.setDirEntries("/tmp/proj", [
      "clean.ts",
      "clean.ts.quanta-tmp-prior-sid-deadbeef",
      "unrelated.ts",
      "other.ts.quanta-tmp-OTHER-sid-cafebabe", // different sessionId — leave alone
    ])
    await c.applyWorkspaceEdit(
      {
        changes: [{ uri: pathToFileURL(a).href, edits: [{ range: r(0, 0, 0, 1), newText: "Y" }] }],
      },
      "prior-sid",
    )
    // The matching stale tmp was unlinked. The OTHER-sid tmp was NOT.
    expect(c.unlinks).toContain("/tmp/proj/clean.ts.quanta-tmp-prior-sid-deadbeef")
    expect(c.unlinks).not.toContain("/tmp/proj/other.ts.quanta-tmp-OTHER-sid-cafebabe")
    expect(c.committed.get(a)).toBe("Y\n")
  })

  test("HELL-ATOM-D2: no stale tmps → cleanup is a no-op (still safe)", async () => {
    const c = new FakeLspClient()
    const a = "/tmp/proj/no-stale.ts"
    c.setFile(a, "q\n")
    c.setDirEntries("/tmp/proj", ["no-stale.ts", "other-file.ts"])
    await c.applyWorkspaceEdit(
      {
        changes: [{ uri: pathToFileURL(a).href, edits: [{ range: r(0, 0, 0, 1), newText: "R" }] }],
      },
      "fresh-sid",
    )
    // listDir was called but nothing matched → 0 cleanup unlinks. The post-
    // commit op is unaffected.
    expect(c.listed).toContain("/tmp/proj")
    expect(c.unlinks).toEqual([])
    expect(c.committed.get(a)).toBe("R\n")
  })
})
