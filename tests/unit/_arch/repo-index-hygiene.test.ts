/**
 * Architecture ratchet — the git INDEX may not carry generated Python artifacts
 * or undeclared gitlinks.
 *
 * Two real recurrences from the aug-21/22 bench campaign motivate this file, and
 * both are index-level defects that no source-tree lint can see:
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
  for (const line of stdout.split("\n")) {
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

const readIndex = (): readonly IndexEntry[] => {
  const out = Bun.spawnSync(["git", "ls-files", "-s"], { cwd: REPO_ROOT })
  if (out.exitCode !== 0) {
    throw new Error(
      `git ls-files -s failed (exit ${out.exitCode}): ${new TextDecoder().decode(out.stderr)}`,
    )
  }
  return parseIndexEntries(new TextDecoder().decode(out.stdout))
}

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
