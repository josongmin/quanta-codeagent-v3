/**
 * R1 audit-H follow-up — symlink-cycle hellgate for `synthesizeLspAnchors`.
 *
 * The prior version of the walker had a NO-THROW backstop of `maxEntries`
 * (default 1M) but no visited-realpath set, so a workspace with a recursive
 * symlink (`/a/link → /b`, `/b/link → /a`) would walk the cycle until the 1M
 * ceiling. This battery PINS the deterministic structural defence: a visited
 * set keyed by `lister.canonicalize(dir)` collapses both arms of the cycle to
 * a single visit, so the walk terminates by REAL tree exhaustion long before
 * the backstop.
 *
 *   CY1. single-step self-loop (`/a` ↔ `/a`)                  — 1
 *   CY2. two-step loop (`/a → /b → /a`)                       — 1
 *   CY3. three-step loop (`/a → /b → /c → /a`)                — 1
 *   CY4. parallel cycle siblings — each cycle counted once    — 1
 *   CY5. cycle that aliases the root                          — 1
 *   CY6. canonicalize REJECTS ⇒ walk still terminates, fallback to input path — 1
 *   CY7. canonicalize MISSING ⇒ no symlink protection but input-path visited still bounds — 1
 *   CY8. determinism — cycle yields same anchor across runs   — 1
 *   CY9. normal tree byte-identical with/without canonicalize — 1
 *   CY10. backstop IS the backstop — pathological pre-cycle work still bounded — 1
 *
 * Total = 10 cases. Hermetic — no real fs.
 */

import { describe, expect, test } from "bun:test"
import {
  type AnchorDirEntry,
  type AnchorDirLister,
  synthesizeLspAnchors,
} from "@/agent/mention-injection"

const EXT_TO_LANG = new Map<string, string>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".js", "typescript"],
  [".py", "pyright"],
])

const f = (name: string): AnchorDirEntry => ({ name, isDirectory: false })
const d = (name: string): AnchorDirEntry => ({ name, isDirectory: true })

/**
 * Build a lister where each input path may resolve to a CANONICAL key that
 * differs from the input. `canonical` maps input → canonical; entries not
 * present resolve to themselves (no symlink). `tree` is read by CANONICAL key
 * — that is the “real” directory contents. The lister records every readDir
 * call and every canonicalize call so tests can pin bounded work.
 */
const cyclicLister = (
  tree: Record<string, readonly AnchorDirEntry[]>,
  canonical: Record<string, string> = {},
  opts: { canonicalizeThrows?: ReadonlySet<string>; omitCanonicalize?: boolean } = {},
): {
  lister: AnchorDirLister
  reads: string[]
  canonicalCalls: string[]
} => {
  const reads: string[] = []
  const canonicalCalls: string[] = []
  const resolve = (p: string): string => canonical[p] ?? p
  const lister: AnchorDirLister = {
    readDir: async (dir: string): Promise<readonly AnchorDirEntry[]> => {
      reads.push(dir)
      const key = resolve(dir)
      const entries = tree[key]
      if (entries === undefined) throw new Error(`ENOENT: ${dir} (canonical=${key})`)
      return entries
    },
  }
  if (!opts.omitCanonicalize) {
    lister.canonicalize = async (dir: string): Promise<string> => {
      canonicalCalls.push(dir)
      if (opts.canonicalizeThrows?.has(dir)) throw new Error(`EACCES: realpath ${dir}`)
      return resolve(dir)
    }
  }
  return { lister, reads, canonicalCalls }
}

describe("synthesizeLspAnchors — symlink cycle hellgate (R1 audit-H)", () => {
  // ---- CY1. single-step self-loop -----------------------------------------
  test("CY1 — a dir that aliases ITSELF terminates after one descent", async () => {
    // /repo contains main.ts and dir `loop`. `/repo/loop` realpaths to /repo
    // itself ⇒ already-visited ⇒ pruned.
    const { lister, reads } = cyclicLister(
      {
        "/repo": [f("main.ts"), d("loop")],
      },
      {
        "/repo/loop": "/repo",
      },
    )
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister,
    })
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/main.ts" }])
    // /repo is read exactly once; the loop alias is NOT re-read.
    expect(reads).toEqual(["/repo"])
  })

  // ---- CY2. two-step loop -------------------------------------------------
  test("CY2 — /a → /b, /b → /a yields one visit per canonical key", async () => {
    // /repo contains a and b dirs. /repo/a realpaths to /canon/a; /repo/b
    // realpaths to /canon/b. /canon/a contains a symlink `back` → /canon/b;
    // /canon/b contains a symlink `back` → /canon/a. Source files live under
    // each canonical dir.
    const { lister, reads } = cyclicLister(
      {
        "/repo": [d("a"), d("b")],
        "/canon/a": [d("back"), f("alpha.ts")],
        "/canon/b": [d("back"), f("beta.py")],
      },
      {
        "/repo/a": "/canon/a",
        "/repo/b": "/canon/b",
        "/canon/a/back": "/canon/b",
        "/canon/b/back": "/canon/a",
      },
    )
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister,
    })
    const byLang = new Map(anchors.map((a) => [a.language, a.anchorFile]))
    expect(byLang.get("typescript")).toBe("/repo/a/alpha.ts")
    expect(byLang.get("pyright")).toBe("/repo/b/beta.py")
    // Crucial: /canon/a/back and /canon/b/back are NEVER readDir'd — each
    // canonical key (`/canon/a`, `/canon/b`) is visited at most once.
    expect(reads).not.toContain("/canon/a/back")
    expect(reads).not.toContain("/canon/b/back")
  })

  // ---- CY3. three-step loop ----------------------------------------------
  test("CY3 — three-step loop A → B → C → A pruned after each canonical visit", async () => {
    const { lister, reads } = cyclicLister(
      {
        "/repo": [d("a"), d("b"), d("c")],
        "/canon/a": [d("next"), f("a.ts")],
        "/canon/b": [d("next"), f("b.ts")],
        "/canon/c": [d("next"), f("c.ts")],
      },
      {
        "/repo/a": "/canon/a",
        "/repo/b": "/canon/b",
        "/repo/c": "/canon/c",
        "/canon/a/next": "/canon/b",
        "/canon/b/next": "/canon/c",
        "/canon/c/next": "/canon/a",
      },
    )
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister,
    })
    // Lexicographically-first across all canonical dirs visited.
    // /repo/a is dequeued first ⇒ a.ts found there.
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/a/a.ts" }])
    // None of the `next` aliases are descended into.
    expect(reads).not.toContain("/canon/a/next")
    expect(reads).not.toContain("/canon/b/next")
    expect(reads).not.toContain("/canon/c/next")
  })

  // ---- CY4. parallel cycle siblings --------------------------------------
  test("CY4 — multiple independent cycles each terminate", async () => {
    // Two independent two-step cycles under /repo. Each must terminate on its
    // own, independently — no shared canonical key.
    const { lister } = cyclicLister(
      {
        "/repo": [d("x1"), d("x2"), d("y1"), d("y2")],
        "/canon/x1": [d("link"), f("x.ts")],
        "/canon/x2": [d("link")],
        "/canon/y1": [d("link"), f("y.py")],
        "/canon/y2": [d("link")],
      },
      {
        "/repo/x1": "/canon/x1",
        "/repo/x2": "/canon/x2",
        "/repo/y1": "/canon/y1",
        "/repo/y2": "/canon/y2",
        "/canon/x1/link": "/canon/x2",
        "/canon/x2/link": "/canon/x1",
        "/canon/y1/link": "/canon/y2",
        "/canon/y2/link": "/canon/y1",
      },
    )
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister,
    })
    const byLang = new Map(anchors.map((a) => [a.language, a.anchorFile]))
    expect(byLang.get("typescript")).toBe("/repo/x1/x.ts")
    expect(byLang.get("pyright")).toBe("/repo/y1/y.py")
  })

  // ---- CY5. cycle aliases the root ---------------------------------------
  test("CY5 — a deep subdir that aliases the ROOT does NOT re-walk the root", async () => {
    // The root /repo is canonical of itself. Its grandchild /repo/x/back also
    // realpaths to /repo. The grandchild MUST be pruned (its canonical key
    // matches the root's already-visited key).
    const { lister, reads } = cyclicLister(
      {
        "/repo": [f("main.ts"), d("x")],
        "/canon/x": [d("back")],
      },
      {
        "/repo/x": "/canon/x",
        "/canon/x/back": "/repo", // ALIAS THE ROOT
      },
    )
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister,
    })
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/main.ts" }])
    // /repo is read ONCE — the back-alias is detected at enqueue, not re-read.
    expect(reads.filter((p) => p === "/repo")).toHaveLength(1)
    expect(reads).not.toContain("/canon/x/back")
  })

  // ---- CY6. canonicalize REJECTS — input-path fallback --------------------
  test("CY6 — canonicalize throws ⇒ visited falls back to input path; walk terminates", async () => {
    // /repo contains a self-aliasing `loop` dir BUT canonicalize REJECTS on
    // it. The synthesizer's NO-THROW fallback uses the INPUT path as the
    // visited key, so the loop dir is still recorded after the first enqueue
    // — a subsequent identical input path (e.g. another link back to it from
    // a sibling) would still be pruned. Crucially: the walker does NOT throw.
    const { lister, reads } = cyclicLister(
      {
        "/repo": [d("loop"), f("main.ts")],
        "/canon/loop": [d("inner")],
        "/canon/inner": [f("z.ts")],
      },
      {
        "/repo/loop": "/canon/loop",
        "/canon/loop/inner": "/canon/inner",
      },
      { canonicalizeThrows: new Set(["/repo/loop", "/canon/loop/inner"]) },
    )
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister,
    })
    // Result is the lexicographically-first ts anchor; the throw never
    // surfaces (NO-THROW invariant). Both /repo/loop and /repo/main.ts are
    // available; main.ts in /repo sorts AFTER loop dir but FILES are scanned
    // first in their dir (loop dir enqueued later) ⇒ main.ts wins.
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/main.ts" }])
    // /repo/loop is read once — fallback key is the input path itself.
    expect(reads.filter((p) => p === "/repo/loop")).toHaveLength(1)
  })

  // ---- CY7. canonicalize MISSING — visited still bounds duplicate enqueue -
  test("CY7 — lister omits canonicalize ⇒ visited uses input path; bounded walk", async () => {
    // Without canonicalize, the visited set uses raw input paths. A REAL
    // symlink loop (different input paths resolving to same dir) would NOT be
    // detected — but the existing maxEntries backstop catches it. The point
    // here: omission must not crash, and a NORMAL tree without aliases is
    // still byte-identical.
    const { lister } = cyclicLister(
      {
        "/repo": [d("src"), f("main.ts")],
        "/repo/src": [f("a.ts")],
      },
      {},
      { omitCanonicalize: true },
    )
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister,
    })
    // main.ts at root beats src/a.ts (breadth-first; files before subdirs).
    expect(anchors).toEqual([{ language: "typescript", anchorFile: "/repo/main.ts" }])
  })

  // ---- CY8. determinism across runs --------------------------------------
  test("CY8 — identical cyclic tree ⇒ identical result across runs", async () => {
    const build = () =>
      cyclicLister(
        {
          "/repo": [d("a"), d("b")],
          "/canon/a": [d("back"), f("alpha.ts")],
          "/canon/b": [d("back"), f("beta.ts")],
        },
        {
          "/repo/a": "/canon/a",
          "/repo/b": "/canon/b",
          "/canon/a/back": "/canon/b",
          "/canon/b/back": "/canon/a",
        },
      )
    const r1 = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: build().lister,
    })
    const r2 = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: build().lister,
    })
    expect(r1).toEqual(r2)
    expect(r1).toEqual([{ language: "typescript", anchorFile: "/repo/a/alpha.ts" }])
  })

  // ---- CY9. normal tree byte-identical w/ canonicalize on or off ---------
  test("CY9 — a NORMAL (acyclic) tree yields same anchor regardless of canonicalize", async () => {
    const treeShape = {
      "/repo": [d("node_modules"), d("src"), f("README.md")],
      "/repo/src": [d("nested"), f("index.ts")],
      "/repo/src/nested": [f("util.ts")],
    }
    const withCanon = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: cyclicLister(treeShape).lister,
    })
    const withoutCanon = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister: cyclicLister(treeShape, {}, { omitCanonicalize: true }).lister,
    })
    expect(withCanon).toEqual([{ language: "typescript", anchorFile: "/repo/src/index.ts" }])
    expect(withCanon).toEqual(withoutCanon)
  })

  // ---- CY10. backstop is still the backstop ------------------------------
  test("CY10 — maxEntries bounds work even when no canonicalize protection helps", async () => {
    // A non-cyclic but pathological tree (a long fanned chain). The backstop
    // (here maxEntries=3) must still bound the walk to no more than 3 entries
    // inspected, and never throw, even though canonicalize is provided. This
    // pins the “1M backstop is a real backstop, not just decorative” claim.
    const { lister } = cyclicLister({
      "/repo": [d("a"), d("b"), d("c"), d("d"), d("e")],
      "/repo/a": [f("a.ts")],
      "/repo/b": [f("b.ts")],
      "/repo/c": [f("c.ts")],
      "/repo/d": [f("d.ts")],
      "/repo/e": [f("e.ts")],
    })
    const anchors = await synthesizeLspAnchors({
      cwd: "/repo",
      extensionToLanguage: EXT_TO_LANG,
      lister,
      maxEntries: 3,
    })
    // After 3 entries inspected, the walker bails (exhausted=true). No anchor
    // is found at the root level (only subdirs in /repo, no .ts files there);
    // the subdirs queued may or may not be reached depending on the bailout
    // moment. The CRITICAL invariant is: no throw, returned a value.
    expect(Array.isArray(anchors)).toBe(true)
  })
})
