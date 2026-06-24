/**
 * ADR-0422 follow-up — deterministic LSP anchor synthesizer hellgate.
 *
 *   A. .ts only ⇒ ts anchor                                  (2)
 *   B. .py only ⇒ py anchor                                  (2)
 *   C. .ts + .py ⇒ BOTH anchors (one per language)           (2)
 *   D. no supported/source file ⇒ [] (LSP strategy disabled) (3)
 *   E. multi-extension language collapses to ONE anchor      (1)
 *   F. determinism — lexicographically-first file wins       (2)
 *   G. breadth-first — shallow file out-ranks deeper file     (1)
 *   H. NO-THROW — a readdir rejection skips that subtree      (2)
 *   I. maxEntries backstop bounds the walk (NO-THROW)        (1)
 *   J. PRUNE — node_modules / .git / dot-dirs are NOT walked  (5)
 *   K. PERF — a missing language does NOT overscan the tree   (3)
 *
 * Total = 24 cases. A hermetic fake tree (no real fs) proves the rule is a
 * pure function of (tree, extension→language map).
 *
 * J/K are the audit-H fix: a roster language that is never present in the tree
 * (e.g. a .py server on a TS-only repo) must NOT force a full-tree walk through
 * node_modules to the maxEntries backstop. The synthesizer prunes ignored
 * directories (deterministic NAME match — no scores) and terminates when the
 * pruned tree is exhausted, regardless of unsatisfied roster languages.
 */

import { describe, expect, test } from "bun:test"
import { type AnchorDirEntry, type AnchorDirLister, synthesizeLspAnchors } from "../anchor-synth"

// extension → language key, mirroring lsp-bridge `SERVERS` collapse
// (.ts/.tsx/.js → one "typescript" key; .py → "pyright").
const EXT_TO_LANG = new Map<string, string>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".js", "typescript"],
  [".py", "pyright"],
])

/** Build a fake tree lister from a path → entries map. A path missing from the
 *  map rejects (simulates ENOENT / EACCES). */
const fakeTree = (
  tree: Record<string, readonly AnchorDirEntry[]>,
  throwOn: ReadonlySet<string> = new Set(),
): AnchorDirLister => ({
  readDir: async (dir: string): Promise<readonly AnchorDirEntry[]> => {
    if (throwOn.has(dir)) throw new Error(`EACCES: ${dir}`)
    const entries = tree[dir]
    if (entries === undefined) throw new Error(`ENOENT: ${dir}`)
    return entries
  },
})

const f = (name: string): AnchorDirEntry => ({ name, isDirectory: false })
const d = (name: string): AnchorDirEntry => ({ name, isDirectory: true })

describe("synthesizeLspAnchors — ADR-0422 follow-up hellgate", () => {
  // -------- A. .ts only -------------------------------------------------
  test("A1 — single .ts file ⇒ ts anchor", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({ "/repo": [f("main.ts")] }),
    })
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/main.ts" }])
  })

  test("A2 — .ts in a nested dir ⇒ ts anchor at the nested path", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({
        "/repo": [d("src")],
        "/repo/src": [f("index.ts")],
      }),
    })
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/src/index.ts" }])
  })

  // -------- B. .py only -------------------------------------------------
  test("B1 — single .py file ⇒ py anchor", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({ "/repo": [f("app.py")] }),
    })
    expect(anchors).toEqual([{ language: "pyright", anchorFile: "/repo/app.py" }])
  })

  test("B2 — synthetic repro scaffold is skipped; real source .py wins", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({
        "/repo": [f("__repro_0_abcdef.py"), f("reproduce_issue.py"), f("z_source.py")],
      }),
    })
    expect(anchors).toEqual([{ language: "pyright", anchorFile: "/repo/z_source.py" }])
  })

  // -------- C. .ts + .py ⇒ both ----------------------------------------
  test("C1 — .ts AND .py present ⇒ one anchor per language", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({ "/repo": [f("a.py"), f("b.ts")] }),
    })
    expect(anchors).toHaveLength(2)
    const byLang = new Map(anchors.map((a) => [a.language, a.anchorFile]))
    expect(byLang.get("typescript")).toBe("/repo/b.ts")
    expect(byLang.get("pyright")).toBe("/repo/a.py")
  })

  test("C2 — both languages across nested dirs ⇒ both anchors", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({
        "/repo": [d("py"), d("ts")],
        "/repo/py": [f("m.py")],
        "/repo/ts": [f("m.ts")],
      }),
    })
    expect(new Set(anchors.map((a) => a.language))).toEqual(new Set(["typescript", "pyright"]))
  })

  // -------- D. no supported file ---------------------------------------
  test("D1 — only unsupported files ⇒ [] (LSP disabled)", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({ "/repo": [f("README.md"), f("data.json"), f("LICENSE")] }),
    })
    expect(anchors).toEqual([])
  })

  test("D2 — empty workspace ⇒ []", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({ "/repo": [] }),
    })
    expect(anchors).toEqual([])
  })

  test("D3 — only synthetic repro scaffolds ⇒ []", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({ "/repo": [f("__repro_12_deadbeef.py"), f("reproduce_issue.py")] }),
    })
    expect(anchors).toEqual([])
  })

  // -------- E. multi-extension language collapse -----------------------
  test("E1 — .ts + .tsx + .js ⇒ ONE typescript anchor (first wins)", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      // sorted order: a.js < b.ts < c.tsx — first supported file is a.js
      lister: fakeTree({ "/repo": [f("a.js"), f("b.ts"), f("c.tsx")] }),
    })
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/a.js" }])
  })

  // -------- F. determinism — lexicographic first -----------------------
  test("F1 — lexicographically-first .ts wins regardless of input order", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      // input order is z, a, m — sorted: a.ts < m.ts < z.ts ⇒ a.ts
      lister: fakeTree({ "/repo": [f("z.ts"), f("a.ts"), f("m.ts")] }),
    })
    expect(anchors[0]?.anchorFile).toBe("/repo/a.ts")
  })

  test("F2 — identical tree ⇒ identical result across runs (byte-stable)", async () => {
    const tree = { "/repo": [f("zebra.ts"), f("alpha.ts")] }
    const r1 = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree(tree),
    })
    const r2 = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree(tree),
    })
    expect(r1).toEqual(r2)
    expect(r1[0]?.anchorFile).toBe("/repo/alpha.ts")
  })

  // -------- G. breadth-first -------------------------------------------
  test("G1 — a shallow .ts out-ranks a deeper .ts (breadth-first)", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({
        // "deep" dir sorts before "shallow.ts" by name, but files in a dir are
        // scanned before its subdirs are descended ⇒ shallow.ts wins.
        "/repo": [d("deep"), f("shallow.ts")],
        "/repo/deep": [f("buried.ts")],
      }),
    })
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/shallow.ts" }])
  })

  // -------- H. NO-THROW on readdir failure -----------------------------
  test("H1 — an unreadable subtree is skipped, sibling still found", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree(
        {
          "/repo": [d("locked"), d("ok")],
          "/repo/ok": [f("good.ts")],
          // "/repo/locked" is in throwOn ⇒ readDir rejects
        },
        new Set(["/repo/locked"]),
      ),
    })
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/ok/good.ts" }])
  })

  test("H2 — root unreadable ⇒ [] (NO-THROW)", async () => {
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({}, new Set(["/repo"])),
    })
    expect(anchors).toEqual([])
  })

  // -------- I. maxEntries backstop -------------------------------------
  test("I1 — maxEntries=1 stops after the first entry (NO-THROW, bounded)", async () => {
    // root has [a.md (unsupported), b.ts] sorted; maxEntries=1 inspects only
    // a.md ⇒ no anchor found (proves the ceiling bounds work without throwing).
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({ "/repo": [f("a.md"), f("b.ts")] }),
      maxEntries: 1,
    })
    expect(anchors).toEqual([])
  })

  // -------- J. PRUNE ignored directories (audit-H fix) ------------------
  // A lister that RECORDS every directory it is asked to read. Pruned dirs
  // (node_modules / .git / dot-dirs) must NEVER appear in `reads` — a NO-THROW
  // swallow would hide a thrown rejection, so we assert on the read SET rather
  // than relying on an exception. `tracked()` returns the lister + the live
  // read set so each test can assert non-descent directly.
  const tracked = (
    tree: Record<string, readonly AnchorDirEntry[]>,
  ): { lister: AnchorDirLister; reads: Set<string> } => {
    const reads = new Set<string>()
    return {
      reads,
      lister: {
        readDir: async (dir: string): Promise<readonly AnchorDirEntry[]> => {
          reads.add(dir)
          const entries = tree[dir]
          if (entries === undefined) throw new Error(`ENOENT: ${dir}`)
          return entries
        },
      },
    }
  }

  test("J1 — node_modules is NOT descended into", async () => {
    const { lister, reads } = tracked({
      "/repo": [d("node_modules"), f("main.ts")],
      "/repo/node_modules": [f("a-dep.ts")],
    })
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister,
    })
    // ts anchor from the source file; node_modules never read.
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/main.ts" }])
    expect(reads.has("/repo/node_modules")).toBe(false)
  })

  test("J2 — .git is NOT descended into", async () => {
    const { lister, reads } = tracked({
      "/repo": [d(".git"), f("app.py")],
      "/repo/.git": [f("config.py")],
    })
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister,
    })
    expect(anchors).toEqual([{ language: "pyright", anchorFile: "/repo/app.py" }])
    expect(reads.has("/repo/.git")).toBe(false)
  })

  test("J3 — a dot-prefixed directory (.quanta) is NOT descended into", async () => {
    const { lister, reads } = tracked({
      "/repo": [d(".quanta"), f("main.ts")],
      "/repo/.quanta": [f("settings.ts")],
    })
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister,
    })
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/main.ts" }])
    expect(reads.has("/repo/.quanta")).toBe(false)
  })

  test("J4 — pruning never changes the anchor a normal tree yields (byte-identical)", async () => {
    // The SAME source tree, once WITH a node_modules sibling that (if walked)
    // sorts BEFORE the real source and contains a .ts — and once WITHOUT it.
    // Pruning means both yield the EXACT same anchor (the real source file),
    // never a node_modules file.
    const withNm = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({
        // "node_modules" sorts before "src"; if walked, a-dep.ts would win.
        "/repo": [d("node_modules"), d("src")],
        "/repo/node_modules": [f("a-dep.ts")],
        "/repo/src": [f("index.ts")],
      }),
    })
    const withoutNm = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({
        "/repo": [d("src")],
        "/repo/src": [f("index.ts")],
      }),
    })
    expect(withNm).toEqual([{ language: "typescript", anchorFile: "/repo/src/index.ts" }])
    expect(withNm).toEqual(withoutNm)
  })

  test("J5 — cwd itself MAY be a dot-dir; its direct files are still inspected", async () => {
    // The root exception: a dot-dir as the WORKSPACE ROOT (e.g. cwd = /x/.quanta)
    // is fine — only its DOT-PREFIXED SUBDIRECTORIES are pruned, not the root.
    const anchors = await synthesizeLspAnchors({
      cwd: "/x/.quanta",
      extensionToLanguage: EXT_TO_LANG,
      lister: fakeTree({ "/x/.quanta": [f("main.ts")] }),
    })
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/x/.quanta/main.ts" }])
  })

  // -------- K. PERF — a missing roster language does NOT overscan -------
  test("K1 — a missing language terminates when the PRUNED tree is exhausted", async () => {
    // Roster = {typescript, pyright}. Tree is TS-only (no .py anywhere). The
    // single huge node_modules subtree (if walked) would dominate the walk —
    // but it is pruned, so the walk exhausts the small real tree quickly even
    // though pyright is never satisfied.
    const { lister, reads } = tracked({
      "/repo": [d("node_modules"), d("src")],
      "/repo/node_modules": [f("a-dep.ts")],
      "/repo/src": [f("index.ts")],
    })
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister,
    })
    // ts found, py never present — but no overscan into node_modules.
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/src/index.ts" }])
    expect(reads.has("/repo/node_modules")).toBe(false)
  })

  test("K2 — a missing language is bounded by entries inspected, not the backstop", async () => {
    // Count how many entries the lister is asked to inspect. With a TS-only
    // tree + a missing pyright, the count must equal the SMALL real tree's
    // entry count — NOT the maxEntries backstop. (Proves termination is by
    // tree-exhaustion, not by burning to the ceiling.)
    let dirReads = 0
    const counting: AnchorDirLister = {
      readDir: async (dir: string): Promise<readonly AnchorDirEntry[]> => {
        dirReads += 1
        const tree: Record<string, readonly AnchorDirEntry[]> = {
          "/repo": [d("node_modules"), d("src")],
          "/repo/src": [f("index.ts"), f("util.ts")],
        }
        const e = tree[dir]
        if (e === undefined) throw new Error(`ENOENT: ${dir}`)
        return e
      },
    }
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: counting,
      maxEntries: 50_000,
    })
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/src/index.ts" }])
    // Only /repo and /repo/src are read — node_modules is pruned, so dirReads
    // is tiny (2), never anything resembling a 50k-entry overscan.
    expect(dirReads).toBe(2)
  })

  test("K3 — a totally absent language on a deep TS tree still returns the ts anchor", async () => {
    const { lister, reads } = tracked({
      "/repo": [d(".git"), d("node_modules"), d("src")],
      "/repo/.git": [f("HEAD.ts")],
      "/repo/node_modules": [f("dep.ts")],
      "/repo/src": [d("deep")],
      "/repo/src/deep": [f("z.ts")],
    })
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister,
    })
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/src/deep/z.ts" }])
    expect(reads.has("/repo/.git")).toBe(false)
    expect(reads.has("/repo/node_modules")).toBe(false)
  })
})
