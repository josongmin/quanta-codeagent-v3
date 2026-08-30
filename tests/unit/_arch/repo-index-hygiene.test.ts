/**
 * Architecture ratchet — the git INDEX may not carry generated Python artifacts,
 * undeclared gitlinks, or a second copy of the source tree.
 *
 * Three real incidents from aug-21/22 motivate this file, and every one of them
 * is an index-level defect that no source-tree lint can see. The third
 * (`isNestedTreeCopy`, documented at its own definition) landed while the first
 * two were being repaired — which is the argument for the file existing at all.
 *
 *  1. **Generated Python artifacts.** CPython bytecode caches under
 *     `adapters/terminal-bench` (`__pycache__` directories holding `.pyc` files)
 *     were committed and then re-committed as BINARY diffs on every adapter
 *     change. The adapter's own `.gitignore` already lists `__pycache__/`, which
 *     is exactly why this rotted silently: ignore rules do not untrack a path
 *     that is ALREADY in the index, so the ignore entry reads like a fence while
 *     the files keep shipping. TB21-06 names "tracked Python build artifacts must
 *     be absent" as a RED rail but shipped no executable check — this is it.
 *
 *  2. **Undeclared gitlinks.** `.worktrees/base` — a local `git worktree` of THIS
 *     repository — was committed as a mode-`160000` gitlink with no `.gitmodules`
 *     entry. Git then records every movement of that worktree's HEAD as a repo
 *     diff, and a fresh clone materialises an empty directory that no
 *     `git submodule update` can fill, because the submodule is not declared
 *     anywhere. A gitlink is legitimate ONLY when `.gitmodules` declares it.
 *
 * ## Why this reads the index rather than the filesystem
 *
 * `git ls-files -s` is the authority for both questions. A developer's local
 * `__pycache__/` or a checked-out worktree directory is fine and must never fail
 * CI; only what is TRACKED is a defect. Reading the index is also the only way to
 * see a gitlink at all — on disk it is an ordinary directory.
 *
 * ## Non-vacuity
 *
 * A ratchet that only asserts "the repo is clean" passes for free the moment the
 * repo IS clean, and then silently survives any later weakening of its own
 * matcher. Each repo-level assertion here is therefore PAIRED with a test that
 * drives the same pure predicate over synthetic offenders and synthetic
 * innocents, so the matcher cannot be hollowed out without a red test.
 *
 * Read-only. Deterministic across platforms.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { assertScanPopulation } from "../_shared/scan-population"

const REPO_ROOT = resolve(import.meta.dir, "../../..")

/* ────────────────────────────── pure predicates ───────────────────────────── */

/**
 * Paths git must never track: CPython bytecode caches and setuptools metadata.
 * Anchored so both the file form (`x.pyc`) and the in-directory form
 * (`__pycache__/x.pyc`, `pkg.egg-info/PKG-INFO`) match — git tracks files, not
 * directories, so a committed cache DIRECTORY only ever appears as its children.
 */
const GENERATED_PYTHON_PATTERNS: readonly RegExp[] = [
  /(^|\/)__pycache__\//,
  /\.py[co]$/,
  /(^|\/)[^/]+\.egg-info\//,
]

export const isGeneratedPythonArtifact = (path: string): boolean =>
  GENERATED_PYTHON_PATTERNS.some((re) => re.test(path))

/**
 * The repository's own top-level source roots. A tracked path that puts one of
 * these UNDER another directory is a second copy of the tree, not a feature.
 */
const SOURCE_ROOTS = ["src", "tests", "tools", "adapters"] as const

/**
 * Is this path a NESTED DUPLICATE of the source tree — i.e. `<anything>/src/…`,
 * `<anything>/tests/…`, and so on?
 *
 * aug-22, commit `0cd1e5b84`: a scratch copy of the whole repository taken for a
 * "pristine tree" audit was committed — 8 238 files, 85 MB, 1.55 M lines, under
 * `.pristine-audit/`. Nothing in the toolchain objected. It is the most
 * expensive index defect this repo has taken and the cheapest to detect: real
 * source lives at the ROOT of each of these directories and nowhere else, so a
 * second `src/` anywhere in the index is a duplicate by construction.
 *
 * Scoped to the FIRST path segment on purpose. `src/tool/git/…` is ordinary
 * source, and a legitimate fixture may well contain a nested `tests/` — what is
 * never legitimate is a top-level sibling of `src/` that itself contains a
 * `src/`, which is exactly the shape a `cp -r` of the repo produces.
 */
export const isNestedTreeCopy = (path: string): boolean => {
  const [first, second] = path.split("/")
  if (first === undefined || second === undefined) return false
  if ((SOURCE_ROOTS as readonly string[]).includes(first)) return false
  return (SOURCE_ROOTS as readonly string[]).includes(second)
}

/** One `git ls-files -s` row, reduced to the two fields this file judges. */
interface IndexEntry {
  readonly mode: string
  readonly path: string
}

/** git's mode for a gitlink (a commit object embedded in a tree). */
const GITLINK_MODE = "160000"

export const isGitlink = (entry: IndexEntry): boolean => entry.mode === GITLINK_MODE

/**
 * Parse `git ls-files -s` output: `<mode> <sha> <stage>\t<path>`.
 *
 * The TAB separator is load-bearing — a path may legally contain spaces, so
 * splitting the whole line on whitespace would truncate such a path and let an
 * offender escape the matcher.
 */
export const parseIndexEntries = (stdout: string): readonly IndexEntry[] => {
  const out: IndexEntry[] = []
  const records = stdout.includes("\0") ? stdout.split("\0") : stdout.split("\n")
  for (const line of records) {
    if (line.trim() === "") continue
    const tab = line.indexOf("\t")
    if (tab === -1) continue
    const meta = line.slice(0, tab).split(" ")
    const mode = meta[0]
    const path = line.slice(tab + 1)
    if (mode === undefined || path === "") continue
    out.push({ mode, path })
  }
  return out
}

/**
 * The submodule paths `.gitmodules` declares. A missing file means "no submodule
 * is declared", which is a legitimate state (and the one this repo is in) — not
 * an error.
 */
export const declaredSubmodulePaths = (gitmodules: string | undefined): ReadonlySet<string> => {
  const out = new Set<string>()
  if (gitmodules === undefined) return out
  for (const line of gitmodules.split("\n")) {
    const m = /^\s*path\s*=\s*(.+?)\s*$/.exec(line)
    if (m?.[1] !== undefined && m[1] !== "") out.add(m[1])
  }
  return out
}

/** Gitlinks that no `.gitmodules` entry accounts for. */
export const undeclaredGitlinks = (
  entries: readonly IndexEntry[],
  declared: ReadonlySet<string>,
): readonly string[] =>
  entries.filter((e) => isGitlink(e) && !declared.has(e.path)).map((e) => e.path)

/* ─────────────────────────────── repo readers ─────────────────────────────── */

const loadIndex = (): readonly IndexEntry[] => {
  const out = Bun.spawnSync(["git", "ls-files", "-s", "-z"], { cwd: REPO_ROOT })
  if (out.exitCode !== 0) {
    throw new Error(
      `git ls-files -s failed (exit ${out.exitCode}): ${new TextDecoder().decode(out.stderr)}`,
    )
  }
  const entries = parseIndexEntries(new TextDecoder().decode(out.stdout))
  // `git ls-files` exits 0 with NO OUTPUT when nothing matches — outside a work
  // tree, or on an empty index — so the exit check above cannot tell "the index
  // is clean" from "git listed nothing", and all three verdicts below would pass
  // over the empty set. Proven: this file passed 7/0 against an empty mirror of
  // the repo's directory skeleton before this floor existed.
  if (entries.length < 12695) {
    throw new Error(
      `git ls-files -s returned ${entries.length} entr(ies) — far below the real index. ` +
        `The hygiene verdicts would be derived from a listing that never happened.`,
    )
  }
  return entries
}

const INDEX_ENTRIES = loadIndex()
assertScanPopulation(
  INDEX_ENTRIES.map((entry) => resolve(REPO_ROOT, entry.path)),
  REPO_ROOT,
  {
    collectable: () => true,
    id: "tests/unit/_arch/repo-index-hygiene.test.ts#INDEX",
  },
)
const readIndex = (): readonly IndexEntry[] => INDEX_ENTRIES

const readGitmodules = (): string | undefined => {
  const path = join(REPO_ROOT, ".gitmodules")
  return existsSync(path) ? readFileSync(path, "utf8") : undefined
}

/* ──────────────────────────────── the ratchet ─────────────────────────────── */

describe("arch: git index hygiene", () => {
  test("no generated Python artifact is tracked (TB21-06 RED rail)", () => {
    const offenders = readIndex()
      .map((e) => e.path)
      .filter(isGeneratedPythonArtifact)

    expect(
      offenders,
      offenders.length > 0
        ? "Generated Python artifacts are TRACKED. A .gitignore entry does not untrack an " +
            `already-indexed path — run \`git rm --cached\` on each:\n  ${offenders.join("\n  ")}`
        : "",
    ).toEqual([])
  })

  test("every tracked gitlink is declared in .gitmodules", () => {
    const offenders = undeclaredGitlinks(readIndex(), declaredSubmodulePaths(readGitmodules()))

    expect(
      offenders,
      offenders.length > 0
        ? "Undeclared gitlink(s) in the index (mode 160000 with no .gitmodules entry). A fresh " +
            "clone gets an empty directory nothing can populate, and local HEAD movement shows " +
            `up as a repo diff. Either declare the submodule or \`git rm --cached\` it:\n  ${offenders.join("\n  ")}`
        : "",
    ).toEqual([])
  })

  test("no second copy of the source tree is tracked", () => {
    const offenders = readIndex()
      .map((e) => e.path)
      .filter(isNestedTreeCopy)
    // Report the roots, not 8 000 paths — the actionable unit is the directory.
    const roots = [...new Set(offenders.map((p) => p.split("/")[0]))].sort()

    expect(
      roots,
      roots.length > 0
        ? "A nested copy of the source tree is TRACKED — every clone pays for it and every " +
            "index-wide tool (ratchets, fc admission, grep) is polluted by a stale twin of " +
            `each file. Untrack the directory (files stay on disk):\n  ${roots
              .map(
                (r) =>
                  `git rm -r --cached ${r}   (${offenders.filter((p) => p.startsWith(`${r}/`)).length} files)`,
              )
              .join("\n  ")}`
        : "",
    ).toEqual([])
  })

  /* ── paired controls: the predicates themselves, on synthetic input ── */

  test("the generated-Python matcher flags every known form and no source file", () => {
    expect(isGeneratedPythonArtifact("adapters/terminal-bench/__pycache__/a.cpython-313.pyc")).toBe(
      true,
    )
    expect(isGeneratedPythonArtifact("__pycache__/top.pyc")).toBe(true)
    expect(isGeneratedPythonArtifact("pkg/mod.pyc")).toBe(true)
    expect(isGeneratedPythonArtifact("pkg/mod.pyo")).toBe(true)
    expect(isGeneratedPythonArtifact("adapters/terminal-bench/quanta.egg-info/PKG-INFO")).toBe(true)
    // real sources and lookalikes must stay clean
    expect(isGeneratedPythonArtifact("adapters/terminal-bench/quanta_agent.py")).toBe(false)
    expect(isGeneratedPythonArtifact("src/pycache/notes.md")).toBe(false)
    expect(isGeneratedPythonArtifact("docs/egg-info.md")).toBe(false)
    expect(isGeneratedPythonArtifact("src/a.pyc.ts")).toBe(false)
  })

  test("the index parser keeps paths that contain spaces intact", () => {
    const parsed = parseIndexEntries(
      "100644 aa 0\tsrc/a.ts\n160000 bb 0\t.worktrees/base\n100644 cc 0\tdocs/my notes.md\n",
    )
    expect(parsed.map((e) => e.path)).toEqual(["src/a.ts", ".worktrees/base", "docs/my notes.md"])
    expect(parsed.filter(isGitlink).map((e) => e.path)).toEqual([".worktrees/base"])
  })

  test("the nested-copy matcher flags a duplicated tree and no real source path", () => {
    // the aug-22 shape, and the same shape under any other scratch root
    expect(isNestedTreeCopy(".pristine-audit/src/agent/prompt.ts")).toBe(true)
    expect(isNestedTreeCopy(".pristine-audit/tests/unit/a.test.ts")).toBe(true)
    expect(isNestedTreeCopy("backup-2026/tools/dev/x.ts")).toBe(true)
    expect(isNestedTreeCopy("vendor/adapters/y.py")).toBe(true)
    // real source, at the root of its own tree, must never be flagged
    expect(isNestedTreeCopy("src/agent/prompt.ts")).toBe(false)
    expect(isNestedTreeCopy("tests/unit/a.test.ts")).toBe(false)
    expect(isNestedTreeCopy("tools/feature-catalog/cli.ts")).toBe(false)
    expect(isNestedTreeCopy("adapters/terminal-bench/quanta_agent.py")).toBe(false)
    // a nested directory that merely SHARES A NAME deeper down is fine — the
    // matcher looks only at the first two segments, so ordinary source that
    // happens to contain `src`/`tests` below the top level is not a duplicate.
    expect(isNestedTreeCopy("src/tool/git/src/x.ts")).toBe(false)
    expect(isNestedTreeCopy("docs/plans/notes.md")).toBe(false)
    expect(isNestedTreeCopy("package.json")).toBe(false)
  })

  test("a gitlink is an offender only while .gitmodules does not declare it", () => {
    const entries = parseIndexEntries("160000 bb 0\tvendor/dep\n100644 aa 0\tsrc/a.ts\n")

    expect(undeclaredGitlinks(entries, declaredSubmodulePaths(undefined))).toEqual(["vendor/dep"])
    expect(
      undeclaredGitlinks(
        entries,
        declaredSubmodulePaths('[submodule "dep"]\n\tpath = vendor/dep\n\turl = https://x/y\n'),
      ),
    ).toEqual([])
    // a declaration for a DIFFERENT path does not excuse this gitlink
    expect(
      undeclaredGitlinks(
        entries,
        declaredSubmodulePaths('[submodule "other"]\n\tpath = vendor/other\n'),
      ),
    ).toEqual(["vendor/dep"])
  })
})
