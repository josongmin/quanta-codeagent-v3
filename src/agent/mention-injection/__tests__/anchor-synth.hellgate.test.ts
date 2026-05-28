/**
 * ADR-0422 follow-up — deterministic LSP anchor synthesizer hellgate.
 *
 *   A. .ts only ⇒ ts anchor                                  (2)
 *   B. .py only ⇒ py anchor                                  (1)
 *   C. .ts + .py ⇒ BOTH anchors (one per language)           (2)
 *   D. no supported file ⇒ [] (LSP strategy disabled)        (2)
 *   E. multi-extension language collapses to ONE anchor      (1)
 *   F. determinism — lexicographically-first file wins       (2)
 *   G. breadth-first — shallow file out-ranks deeper file     (1)
 *   H. NO-THROW — a readdir rejection skips that subtree      (2)
 *   I. maxEntries backstop bounds the walk (NO-THROW)        (1)
 *
 * Total = 14 cases. A hermetic fake tree (no real fs) proves the rule is a
 * pure function of (tree, extension→language map).
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
})
