/**
 * CHARACTERIZATION suite for `src/apps/cli/at-autocomplete/recursive-file-list.ts`.
 *
 * WHY THIS FILE EXISTS: the module was the least-covered of the campaign's
 * worst functions — exactly ONE test file mentioned it, and only at the
 * "does the right label appear" altitude. `buildIndexViaWalk` (cognitive
 * complexity 42) and the returned query closure (23) were about to be split,
 * and a split of code nothing exercises is unfalsifiable. So this suite pins
 * what the code DOES today — including the parts that are surprising — so the
 * refactor is checkable rather than merely plausible.
 *
 * PINNED, NOT ENDORSED. Several assertions below record behaviour that is
 * arguably wrong (a broken symlink surfaces as a file candidate; the
 * `fileSource` path applies NO hidden/node_modules pruning; the index is not
 * de-duplicated). They are pinned deliberately: surprising-but-real is exactly
 * what a refactor destroys silently.
 *
 * ORDER IS LOAD-BEARING. This is an autocomplete dropdown — the first N
 * entries are what the user sees. Every ordering assertion here is a full
 * `toEqual` on the label array, never a `toContain`.
 *
 * Probe idiom: `list("")` ranks every entry at tier 0 in index order
 * (`fuzzy.ts` — empty query keeps input order), so with a large `maxResults`
 * it is a faithful read-out of the whole index IN INDEX ORDER.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createRecursiveFileLister,
  ripgrepFileSource,
} from "../../../../../src/apps/cli/at-autocomplete/recursive-file-list"

/** `realpathSync` matters: on macOS `tmpdir()` is `/var/folders/...`, a
 *  symlink to `/private/var/folders/...`. The walk compares a REALPATH'd
 *  root against realpath'd children, so an unresolved root makes the
 *  broken-symlink case environment-dependent. Resolving up front makes every
 *  containment assertion below deterministic on macOS and Linux alike. */
const mkRoot = (tag: string): string => realpathSync(mkdtempSync(join(tmpdir(), `rfl-${tag}-`)))

/** Read the ENTIRE index, in index order, as display labels. */
const indexOrder = async (
  list: (q: string, s?: AbortSignal) => Promise<readonly { readonly label: string }[]>,
): Promise<readonly string[]> => (await list("")).map((c) => c.label)

/** Force the JS-walk fallback (the `rg`-absent branch) deterministically. */
const walkSource = async (): Promise<null> => null

// ── A. JS-walk fallback: enumeration order + prune rules ───────────────

describe("A. buildIndexViaWalk — order, ignore rules, caps", () => {
  let root: string
  beforeAll(() => {
    root = mkRoot("walk")
    // .gitignore: a dir rule, a NEGATED re-include under it, and a file rule.
    writeFileSync(join(root, ".gitignore"), "ignored/\n!ignored/keep.ts\nbanned.txt\n")
    writeFileSync(join(root, ".hidden.ts"), "x")
    mkdirSync(join(root, ".hiddendir"))
    writeFileSync(join(root, ".hiddendir", "h.ts"), "x")
    writeFileSync(join(root, "banned.txt"), "x")
    mkdirSync(join(root, "empty"))
    mkdirSync(join(root, "ignored"))
    writeFileSync(join(root, "ignored", "junk.ts"), "x")
    writeFileSync(join(root, "ignored", "keep.ts"), "x")
    mkdirSync(join(root, "node_modules"))
    writeFileSync(join(root, "node_modules", "nm.ts"), "x")
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "a.ts"), "x")
    mkdirSync(join(root, "src", "deep"))
    writeFileSync(join(root, "src", "deep", "b.ts"), "x")
    writeFileSync(join(root, "top.md"), "x")
    writeFileSync(join(root, "with space.ts"), "x")
    writeFileSync(join(root, "유니코드.ts"), "x")
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const walkLister = (extra: Record<string, unknown> = {}) =>
    createRecursiveFileLister({
      fileRoot: root,
      maxResults: 1000,
      fileSource: walkSource,
      ...extra,
    })

  test("A1 — EXACT index order is breadth-first, alphabetical within a directory", async () => {
    // The full, byte-exact contract. A directory is emitted BEFORE its own
    // contents but INTERLEAVED alphabetically with its sibling files, and an
    // entire level is emitted before the next level begins. Directories carry
    // a trailing `/`. Non-ASCII sorts by code unit (so `유니코드` is last).
    expect(await indexOrder(walkLister())).toEqual([
      // level 1, alphabetical
      "empty/",
      "src/",
      "top.md",
      "with space.ts",
      "유니코드.ts",
      // level 2, in level-1 queue order (empty, ignored, src)
      "ignored/keep.ts",
      "src/a.ts",
      "src/deep/",
      // level 3
      "src/deep/b.ts",
    ])
  })

  test("A2 — dotfiles AND dot-directories are skipped wholesale", async () => {
    const labels = await indexOrder(walkLister())
    expect(labels).not.toContain(".hidden.ts")
    expect(labels).not.toContain(".hiddendir/")
    expect(labels).not.toContain(".hiddendir/h.ts")
    expect(labels).not.toContain(".gitignore")
  })

  test("A3 — `node_modules` is pruned by name, not by .gitignore", async () => {
    // The fixture's .gitignore does NOT mention node_modules — the walk's
    // ALWAYS_PRUNE set is what drops it, dir entry and children alike.
    const labels = await indexOrder(walkLister())
    expect(labels).not.toContain("node_modules/")
    expect(labels).not.toContain("node_modules/nm.ts")
  })

  test("A4 — root .gitignore is honoured for files", async () => {
    expect(await indexOrder(walkLister())).not.toContain("banned.txt")
  })

  test("A5 — SURPRISE: an ignored dir is descended for a negated re-include, but the DIR ITSELF never becomes a candidate", async () => {
    // `ignored/` matches the ignore rule so it is never offered as a
    // directory candidate — yet `!ignored/keep.ts` forces the walk to descend
    // it anyway, and the re-included child DOES surface. `ignored/junk.ts`
    // stays ignored. This asymmetry (child visible, parent invisible) is a
    // real, user-visible quirk of the current code.
    const labels = await indexOrder(walkLister())
    expect(labels).not.toContain("ignored/")
    expect(labels).toContain("ignored/keep.ts")
    expect(labels).not.toContain("ignored/junk.ts")
  })

  test("A6 — honorIgnore:false disables the ignore file (paired control for A4/A5)", async () => {
    const labels = await indexOrder(walkLister({ honorIgnore: false }))
    expect(labels).toContain("banned.txt")
    expect(labels).toContain("ignored/")
    expect(labels).toContain("ignored/junk.ts")
    // ...but hidden + node_modules pruning is INDEPENDENT of the ignore file
    // and still applies. This separates the two prune mechanisms.
    expect(labels).not.toContain(".hidden.ts")
    expect(labels).not.toContain("node_modules/nm.ts")
  })

  test("A7 — an EMPTY directory is still offered as a candidate", async () => {
    expect(await indexOrder(walkLister())).toContain("empty/")
  })

  test("A8 — filenames with spaces and non-ASCII are indexed verbatim", async () => {
    const list = walkLister()
    expect((await list("with space")).map((c) => c.label)).toEqual(["with space.ts"])
    expect((await list("유니")).map((c) => c.label)).toEqual(["유니코드.ts"])
  })

  test("A9 — maxFiles truncates the walk at the FIRST N reached (breadth-first, so shallowest)", async () => {
    expect(await indexOrder(walkLister({ maxFiles: 3 }))).toEqual(["empty/", "src/", "top.md"])
    expect(await indexOrder(walkLister({ maxFiles: 1 }))).toEqual(["empty/"])
  })

  test("A11 — maxFiles binds ACROSS directories, not per-directory", async () => {
    // The cap must be a running total: when the budget runs out mid-way
    // through a DEEP directory, that directory is abandoned part-read. Here
    // `src` is reached with 1 slot left, so `src/a.ts` lands and `src/deep/`
    // (the very next sibling) does not. A per-directory budget would emit
    // both and overshoot to 8.
    expect(await indexOrder(walkLister({ maxFiles: 7 }))).toEqual([
      "empty/",
      "src/",
      "top.md",
      "with space.ts",
      "유니코드.ts",
      "ignored/keep.ts",
      "src/a.ts",
    ])
  })

  test("A10 — a non-existent root walks to [] rather than throwing", async () => {
    const list = createRecursiveFileLister({
      fileRoot: join(root, "no-such-dir"),
      fileSource: walkSource,
    })
    expect(await list("")).toEqual([])
    expect(await list("anything")).toEqual([])
  })
})

// ── B. JS-walk fallback: symlinks ──────────────────────────────────────

describe("B. buildIndexViaWalk — symlink handling", () => {
  let root: string
  let outside: string
  let symlinksWork = true
  beforeAll(() => {
    root = mkRoot("link")
    outside = mkRoot("outside")
    writeFileSync(join(outside, "secret.txt"), "x")
    writeFileSync(join(root, "real.txt"), "x")
    mkdirSync(join(root, "target"))
    writeFileSync(join(root, "target", "t.ts"), "x")
    mkdirSync(join(root, "cycle"))
    try {
      symlinkSync(join(root, "real.txt"), join(root, "link-to-file"))
      symlinkSync(join(root, "target"), join(root, "link-to-dir"))
      symlinkSync(join(root, "cycle"), join(root, "cycle", "self")) // self-referential
      symlinkSync(join(root, "nowhere-at-all"), join(root, "broken-link"))
      symlinkSync(outside, join(root, "escape")) // escapes the jail
    } catch {
      symlinksWork = false // some sandboxes forbid symlink(2)
    }
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  const lister = () =>
    createRecursiveFileLister({ fileRoot: root, maxResults: 1000, fileSource: walkSource })

  test("B1 — EXACT order with symlinks present; every in-root link is a FILE candidate", async () => {
    if (!symlinksWork) return
    // SURPRISES pinned here, all at once:
    //  * `link-to-dir` is a symlink to a directory — `Dirent.isDirectory()` is
    //    FALSE for a link, so it is offered as a FILE (no trailing `/`) and is
    //    NEVER descended. `target/t.ts` is reachable only via the real dir.
    //  * `broken-link` points at nothing, yet it IS offered as a candidate —
    //    `canonicalize` swallows the ENOENT and returns the path unchanged,
    //    which then tests as "inside root".
    //  * `cycle/self` points at its own parent; because links are never
    //    descended, this terminates and simply yields one file candidate.
    expect(await indexOrder(lister())).toEqual([
      "broken-link",
      "cycle/",
      "link-to-dir",
      "link-to-file",
      "real.txt",
      "target/",
      "cycle/self",
      "target/t.ts",
    ])
  })

  test("B2 — a symlink whose target escapes root is dropped (the jail)", async () => {
    if (!symlinksWork) return
    const list = lister()
    expect(await indexOrder(list)).not.toContain("escape")
    expect(await list("escape")).toEqual([])
    expect(await list("secret")).toEqual([])
  })

  test("B3 — a self-referential symlink cycle terminates and does not duplicate", async () => {
    if (!symlinksWork) return
    const labels = await indexOrder(lister())
    expect(labels.filter((l) => l === "cycle/self")).toHaveLength(1)
    expect(labels.filter((l) => l === "cycle/")).toHaveLength(1)
  })

  test("B4 — an absolute query is refused before the index is even consulted", async () => {
    let built = 0
    const list = createRecursiveFileLister({
      fileRoot: root,
      fileSource: async () => {
        built += 1
        return ["real.txt"]
      },
    })
    expect(await list(`${outside}/secret.txt`)).toEqual([])
    expect(built).toBe(0) // short-circuit happens BEFORE ensureIndex
  })
})

// ── C. JS-walk fallback: unreadable entries ────────────────────────────

describe("C. buildIndexViaWalk — unreadable entries", () => {
  let root: string
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0
  beforeAll(() => {
    root = mkRoot("perm")
    mkdirSync(join(root, "noread"))
    writeFileSync(join(root, "noread", "child.ts"), "x")
    writeFileSync(join(root, "sibling.ts"), "x")
    writeFileSync(join(root, "mode000.ts"), "x")
    chmodSync(join(root, "mode000.ts"), 0o000)
    chmodSync(join(root, "noread"), 0o000)
  })
  afterAll(() => {
    chmodSync(join(root, "noread"), 0o755)
    rmSync(root, { recursive: true, force: true })
  })

  test("C1 — an unreadable DIRECTORY still appears as a candidate; its children do not, and the walk continues", async () => {
    if (isRoot) return // mode 000 is not a barrier for uid 0
    const labels = await indexOrder(
      createRecursiveFileLister({ fileRoot: root, maxResults: 1000, fileSource: walkSource }),
    )
    // `noread/` is emitted (the parent readdir saw it) but its readdir throws
    // and is swallowed — so `noread/child.ts` is absent while `sibling.ts`,
    // which comes AFTER it in the queue, still lands.
    expect(labels).toEqual(["mode000.ts", "noread/", "sibling.ts"])
  })

  test("C2 — a mode-000 FILE is still indexed (the lister never opens it)", async () => {
    if (isRoot) return
    expect(
      await indexOrder(
        createRecursiveFileLister({ fileRoot: root, maxResults: 1000, fileSource: walkSource }),
      ),
    ).toContain("mode000.ts")
  })
})

// ── D. fileSource path (deriveEntries) ─────────────────────────────────

describe("D. deriveEntries — the fileSource path is a DIFFERENT pipeline", () => {
  let root: string
  beforeAll(() => {
    root = mkRoot("derive")
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const from = (files: readonly string[], extra: Record<string, unknown> = {}) =>
    createRecursiveFileLister({
      fileRoot: root,
      maxResults: 1000,
      fileSource: async () => files,
      ...extra,
    })

  test("D1 — EXACT index order is depth-ASC then lexical, NOT breadth-first-by-queue", async () => {
    // Contrast with A1: here files and their derived ancestor dirs are pooled
    // and sorted globally by (depth, lexical). A dir and a file at the same
    // depth interleave lexically.
    expect(await indexOrder(from(["z/b.ts", "a.ts", "z/a.ts", "m/n/o.ts"]))).toEqual([
      "a.ts",
      "m/",
      "z/",
      "m/n/",
      "z/a.ts",
      "z/b.ts",
      "m/n/o.ts",
    ])
  })

  test("D2 — every ancestor directory is synthesised, even one the source never named", async () => {
    expect(await indexOrder(from(["a/b/c/d.ts"]))).toEqual(["a/", "a/b/", "a/b/c/", "a/b/c/d.ts"])
  })

  test("D3 — SURPRISE: no hidden-file and no node_modules pruning on this path", async () => {
    // ALWAYS_PRUNE and the dotfile rule live in the WALK only. A source that
    // is not `rg` (or an `rg` invoked without its default filters) leaks both.
    expect(await indexOrder(from([".hidden", "node_modules/x.ts", ".config/y.ts"]))).toEqual([
      ".config/",
      ".hidden",
      "node_modules/",
      ".config/y.ts",
      "node_modules/x.ts",
    ])
  })

  test("D4 — SURPRISE: no de-duplication; a repeated source path yields repeated candidates", async () => {
    expect(await indexOrder(from(["a.ts", "a.ts", "a.ts"]))).toEqual(["a.ts", "a.ts", "a.ts"])
  })

  test("D5 — SURPRISE: one name can be BOTH a file and a dir candidate, file first", async () => {
    // Source says `a` is a file AND `a/b.ts` exists. Both survive; the stable
    // sort puts the file before the dir because files are concatenated first.
    const out = await from(["a", "a/b.ts"])("")
    expect(out.map((c) => `${c.detail}:${c.label}`)).toEqual(["file:a", "dir:a/", "file:a/b.ts"])
  })

  test("D6 — jail: absolute and `..`-escaping source paths are dropped, in-root ones survive", async () => {
    expect(
      await indexOrder(from(["/etc/passwd", "..", "../up.txt", "a/../../b.txt", "ok/fine.ts"])),
    ).toEqual(["ok/", "ok/fine.ts"])
  })

  test("D7 — maxFiles truncates the DEPTH-SORTED list, so the deepest entries are cut", async () => {
    expect(await indexOrder(from(["a.ts", "d/b.ts", "d/e/c.ts"], { maxFiles: 3 }))).toEqual([
      "a.ts",
      "d/",
      "d/b.ts",
    ])
  })

  test("D8 — an empty source list is a legitimate empty index, not a fallback trigger", async () => {
    let walked = false
    const list = createRecursiveFileLister({
      fileRoot: root,
      fileSource: async () => {
        walked = true
        return []
      },
    })
    expect(await list("anything")).toEqual([])
    expect(walked).toBe(true)
  })
})

// ── E. query projection: keys, ranking, caps ───────────────────────────

describe("E. query closure — key selection, cap, projection", () => {
  let root: string
  beforeAll(() => {
    root = mkRoot("query")
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const from = (files: readonly string[], extra: Record<string, unknown> = {}) =>
    createRecursiveFileLister({ fileRoot: root, fileSource: async () => files, ...extra })

  test("E1 — a SLASH-free query matches the BASENAME (reaches a deep file)", async () => {
    const list = from(["src/apps/bench/driver.ts", "other.ts"])
    expect((await list("driver")).map((c) => c.label)).toEqual(["src/apps/bench/driver.ts"])
  })

  test("E2 — a query containing `/` matches the FULL relative path instead", async () => {
    const list = from(["src/util.ts", "lib/util.ts"])
    expect((await list("src/util")).map((c) => c.label)).toEqual(["src/util.ts"])
    // ...and the bare-basename form reaches both, in index order.
    expect((await list("util")).map((c) => c.label)).toEqual(["lib/util.ts", "src/util.ts"])
  })

  test("E3 — matching is case-insensitive on both key paths", async () => {
    const list = from(["src/Driver.ts"])
    expect((await list("driver")).map((c) => c.label)).toEqual(["src/Driver.ts"])
    expect((await list("SRC/dri")).map((c) => c.label)).toEqual(["src/Driver.ts"])
  })

  test("E4 — tier order (exact > prefix > substring) survives the projection", async () => {
    const list = from(["x-util.ts", "util-helper.ts", "util"])
    expect((await list("util")).map((c) => c.label)).toEqual([
      "util", // exact basename
      "util-helper.ts", // prefix
      "x-util.ts", // substring
    ])
  })

  test("E5 — a directory candidate gets a trailing slash in BOTH label and insertText", async () => {
    // NOTE the omission: a bare (slash-free) query ranks against BASENAMES, so
    // `src` matches the synthesised dir `src` but NOT the file `src/a.ts`
    // (basename `a.ts`). The trailing `/` on the dir is what lets the next
    // keystroke turn this into the slash-query form.
    const out = await from(["src/a.ts"])("src")
    expect(out.map((c) => ({ ...c }))).toEqual([
      { kind: "file", insertText: "@src/", label: "src/", detail: "dir" },
    ])
    // ...and the slash form then reaches the child. SURPRISE: the directory
    // itself DROPS OUT of its own descent listing — the rel keys carry no
    // trailing slash, so `src` does not contain the query `src/`.
    expect((await from(["src/a.ts"])("src/")).map((c) => c.label)).toEqual(["src/a.ts"])
  })

  test("E6 — the result cap defaults to 8 and truncates the RANKED head", async () => {
    const files = Array.from({ length: 12 }, (_, i) => `a${i}.ts`)
    const out = await from(files)("a")
    expect(out).toHaveLength(8)
    expect(out.map((c) => c.label)).toEqual([
      "a0.ts",
      "a1.ts",
      "a10.ts",
      "a11.ts",
      "a2.ts",
      "a3.ts",
      "a4.ts",
      "a5.ts",
    ])
  })

  test("E7 — maxResults is truncated toward zero; non-positive / non-finite falls back to 8", async () => {
    const files = Array.from({ length: 12 }, (_, i) => `a${i}.ts`)
    expect(await from(files, { maxResults: 2.9 })("a")).toHaveLength(2)
    expect(await from(files, { maxResults: 1 })("a")).toHaveLength(1)
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await from(files, { maxResults: bad })("a")).toHaveLength(8)
    }
  })

  test("E8 — maxFiles is truncated toward zero; non-positive / non-finite falls back to the default", async () => {
    const files = ["a1.ts", "d/a2.ts", "d/e/a3.ts"]
    expect(
      (await from(files, { maxFiles: 1.9, maxResults: 100 })("a")).map((c) => c.label),
    ).toEqual(["a1.ts"])
    for (const bad of [0, -1, Number.NaN]) {
      expect(
        (await from(files, { maxFiles: bad, maxResults: 100 })("a")).map((c) => c.label),
      ).toEqual(["a1.ts", "d/a2.ts", "d/e/a3.ts"])
    }
  })

  test("E9 — a no-match query is [] (paired control against 'returns everything')", async () => {
    const list = from(["src/a.ts"])
    expect(await list("zzzz-nothing")).toEqual([])
    expect((await list("a")).length).toBeGreaterThan(0)
  })
})

// ── F. lifecycle: caching, concurrency, abort, failure ─────────────────

describe("F. lifecycle — build caching, abort, degradation", () => {
  let root: string
  beforeAll(() => {
    root = mkRoot("life")
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("F1 — the source is enumerated exactly once and reused for every keystroke", async () => {
    let calls = 0
    const list = createRecursiveFileLister({
      fileRoot: root,
      fileSource: async () => {
        calls += 1
        return ["src/util.ts", "src/driver.ts"]
      },
    })
    await list("u")
    await list("dr")
    await list("")
    await list("nomatch")
    expect(calls).toBe(1)
  })

  test("F2 — concurrent first calls share ONE in-flight build", async () => {
    let calls = 0
    const list = createRecursiveFileLister({
      fileRoot: root,
      fileSource: async () => {
        calls += 1
        await new Promise((r) => setTimeout(r, 5))
        return ["a.ts"]
      },
    })
    const outs = await Promise.all([list("a"), list("a"), list("a")])
    expect(calls).toBe(1)
    for (const o of outs) expect(o.map((c) => c.label)).toEqual(["a.ts"])
  })

  test("F3 — an already-aborted signal returns [] WITHOUT building the index", async () => {
    let calls = 0
    const list = createRecursiveFileLister({
      fileRoot: root,
      fileSource: async () => {
        calls += 1
        return ["a.ts"]
      },
    })
    const ac = new AbortController()
    ac.abort()
    expect(await list("a", ac.signal)).toEqual([])
    expect(calls).toBe(0)
  })

  test("F4 — a signal aborted DURING the build drops that result but KEEPS the cache", async () => {
    // Deliberate design (documented in the source): the build is not cancelled
    // by a per-keystroke signal, so the superseded keystroke returns [] while
    // the next one is served from cache with no re-enumeration.
    const ac = new AbortController()
    let calls = 0
    const list = createRecursiveFileLister({
      fileRoot: root,
      fileSource: async () => {
        calls += 1
        ac.abort()
        return ["a.ts"]
      },
    })
    expect(await list("a", ac.signal)).toEqual([])
    expect((await list("a")).map((c) => c.label)).toEqual(["a.ts"])
    expect(calls).toBe(1)
  })

  test("F5 — a throwing source degrades to [] and is RETRIED on the next call (no negative caching)", async () => {
    let calls = 0
    const list = createRecursiveFileLister({
      fileRoot: root,
      fileSource: async () => {
        calls += 1
        throw new Error("boom")
      },
    })
    expect(await list("a")).toEqual([])
    expect(await list("a")).toEqual([])
    expect(calls).toBe(2)
  })

  test("F6 — a source returning null routes to the walk (and the walk result is cached)", async () => {
    let calls = 0
    const r = mkRoot("null-src")
    writeFileSync(join(r, "w.ts"), "x")
    try {
      const list = createRecursiveFileLister({
        fileRoot: r,
        fileSource: async () => {
          calls += 1
          return null
        },
      })
      expect((await list("w")).map((c) => c.label)).toEqual(["w.ts"])
      await list("w")
      expect(calls).toBe(1)
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  test("F7 — an absent / empty / non-string fileRoot makes every call []", async () => {
    for (const bad of ["", undefined, null, 42]) {
      const list = createRecursiveFileLister({
        fileRoot: bad as unknown as string,
        fileSource: async () => ["a.ts"],
      })
      expect(await list("a")).toEqual([])
      expect(await list("")).toEqual([])
    }
  })

  test("F8 — a non-string query is refused, not coerced", async () => {
    const list = createRecursiveFileLister({ fileRoot: root, fileSource: async () => ["a.ts"] })
    for (const bad of [null, undefined, 42, {}]) {
      expect(await list(bad as unknown as string)).toEqual([])
    }
  })
})

// ── G. ripgrepFileSource (the default source) ──────────────────────────

describe("G. ripgrepFileSource — the real subprocess", () => {
  let rgWorks = false
  let root: string
  beforeAll(async () => {
    root = mkRoot("rg")
    writeFileSync(join(root, "ok.ts"), "x")
    const probe = await ripgrepFileSource(root)
    rgWorks = probe !== null
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("G1 — a non-existent cwd degrades to null (⇒ the walk), never a throw", async () => {
    expect(await ripgrepFileSource(join(root, "no-such-dir"))).toBeNull()
  })

  test("G2 — an EMPTY tree is [] (a real empty index), not null (which would force the walk)", async () => {
    if (!rgWorks) return
    const empty = mkRoot("rg-empty")
    try {
      expect(await ripgrepFileSource(empty)).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test("G3 — hidden files and node_modules are excluded by rg itself", async () => {
    if (!rgWorks) return
    const r = mkRoot("rg-prune")
    try {
      writeFileSync(join(r, "visible.ts"), "x")
      writeFileSync(join(r, ".hidden.ts"), "x")
      mkdirSync(join(r, "node_modules"))
      writeFileSync(join(r, "node_modules", "dep.ts"), "x")
      expect(await ripgrepFileSource(r)).toEqual(["visible.ts"])
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  test("G4 — SURPRISE: rg honours .gitignore only INSIDE a git repo; the walk honours it always", async () => {
    if (!rgWorks) return
    // This is a genuine divergence between the two sources, not a bug in this
    // module: `rg` requires a `.git` directory before it applies `.gitignore`.
    // So the same tree yields a DIFFERENT index depending on which source ran.
    const noGit = mkRoot("rg-nogit")
    const withGit = mkRoot("rg-git")
    try {
      for (const r of [noGit, withGit]) {
        writeFileSync(join(r, ".gitignore"), "banned.txt\n")
        writeFileSync(join(r, "banned.txt"), "x")
        writeFileSync(join(r, "ok.ts"), "x")
      }
      mkdirSync(join(withGit, ".git"))
      expect((await ripgrepFileSource(noGit))?.slice().sort()).toEqual(["banned.txt", "ok.ts"])
      expect(await ripgrepFileSource(withGit)).toEqual(["ok.ts"])
      // paired control: the WALK drops it in both trees.
      for (const r of [noGit, withGit]) {
        const walked = await indexOrder(
          createRecursiveFileLister({ fileRoot: r, maxResults: 100, fileSource: walkSource }),
        )
        expect(walked).toEqual(["ok.ts"])
      }
    } finally {
      rmSync(noGit, { recursive: true, force: true })
      rmSync(withGit, { recursive: true, force: true })
    }
  })

  test("G5 — rg does not follow or emit symlinks (unlike the walk, which offers them as files)", async () => {
    if (!rgWorks) return
    const r = mkRoot("rg-link")
    try {
      writeFileSync(join(r, "real.ts"), "x")
      mkdirSync(join(r, "d"))
      writeFileSync(join(r, "d", "inner.ts"), "x")
      symlinkSync(join(r, "real.ts"), join(r, "link.ts"))
      symlinkSync(join(r, "d"), join(r, "linkdir"))
      const out = await ripgrepFileSource(r)
      expect(out?.slice().sort()).toEqual(["d/inner.ts", "real.ts"])
    } catch {
      // symlink(2) unavailable — nothing to characterise here.
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  test("G7 — a non-zero rg exit is IGNORED when stdout carried files (the EACCES regression)", async () => {
    // rg exits 2 when ANY subdirectory is unreadable, but still streams every
    // file it did read. Discarding that stdout would demote the whole
    // workspace to the ~40x slower walk over one permission-denied folder —
    // the exact regression the source comments call out. Reproduced with a
    // real mode-000 subdirectory.
    if (!rgWorks || (typeof process.getuid === "function" && process.getuid() === 0)) return
    const r = mkRoot("rg-eacces")
    mkdirSync(join(r, "deny"))
    writeFileSync(join(r, "deny", "d.ts"), "x")
    writeFileSync(join(r, "ok.ts"), "x")
    mkdirSync(join(r, "sub"))
    writeFileSync(join(r, "sub", "s.ts"), "x")
    chmodSync(join(r, "deny"), 0o000)
    try {
      const out = await ripgrepFileSource(r)
      expect(out).not.toBeNull()
      expect(out?.slice().sort()).toEqual(["ok.ts", "sub/s.ts"])
    } finally {
      chmodSync(join(r, "deny"), 0o755)
      rmSync(r, { recursive: true, force: true })
    }
  })

  test("G6 — the default lister (no fileSource) reaches a deep file end-to-end", async () => {
    const r = mkRoot("rg-e2e")
    try {
      mkdirSync(join(r, "src"), { recursive: true })
      mkdirSync(join(r, "src", "apps"))
      writeFileSync(join(r, "src", "apps", "driver.ts"), "x")
      const list = createRecursiveFileLister({ fileRoot: r })
      expect((await list("driver")).map((c) => c.label)).toEqual(["src/apps/driver.ts"])
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })
})
