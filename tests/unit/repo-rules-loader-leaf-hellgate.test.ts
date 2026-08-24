/**
 * OWNER-LOCAL LEAF-UNIT hellgate — `loadRepoRules` intrinsic walk-up contract.
 *
 * Owner module: `src/agent/repo-rules.ts`. This pins loader edges that the
 * three existing suites leave UNCOVERED (verified against each), driving the
 * real loader with real temp dirs (no mocks, self-cleaning mkdtemp + rm):
 *
 *   §A  MAX_DEPTH=16 is a HARD boundary — a rule strictly beyond 16 hops (in a
 *       `.git`-less loose chain) is NEVER reached, and the walk terminates
 *       bounded (existing HELL-14 only walks 6 levels and asserts undefined; it
 *       never proves the 16-hop cutoff line nor that a nearer rule still loads).
 *   §B  `.git` boundary is INCLUDE-then-STOP w.r.t. the PARENT — a rule sitting
 *       in the `.git`-root's parent dir is NOT loaded (HELL-3 proves the root is
 *       included and deeper dirs stop there, but never plants a parent rule to
 *       prove the parent side of the stop).
 *   §C  DEFAULT home boundary path (no `opts.homeDir`, no injected `now`) is
 *       exercised on a positive `.git`-rooted load — every existing walk-up test
 *       either passes an explicit `homeDir` or lives under `.git`; the default
 *       `homedir()` code path is never linked in a positive-load assertion.
 *
 * Redundancy audit (SKIPPED — already covered):
 *   - symlink-FILE rejection: covered by repo-rules.test.ts "symlink rejection
 *     (security)" (3 cases) and tree HELL-5. Not re-tested.
 *   - MAX_BYTES truncate-with-marker (exact 64 KiB offset): covered by
 *     repo-rules.test.ts "size cap" and tree HELL-13. Not re-tested.
 *   - homeDir above-boundary exclusion + case-fold: covered by
 *     repo-rules-walkup-security-hellgate.test.ts §2. Not re-tested.
 *   - multi-candidate-per-dir: the code returns the FIRST present candidate per
 *     dir (single winner, not "both become layers"), covered by HELL-8 and
 *     repo-rules.test.ts "prefers AGENTS.md". Not re-tested.
 *
 * Every assertion carries a non-vacuous paired positive so a loader that
 * silently reads nothing cannot pass green.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { loadRepoRules, MAX_BYTES, REPO_RULE_CANDIDATES } from "@/agent/repo-rules"
import { present } from "../_helpers/expect-present"

const roots: string[] = []
const freshRoot = async (label: string): Promise<string> => {
  const r = await mkdtemp(join(tmpdir(), `repo-rules-leaf-${label}-`))
  roots.push(r)
  return r
}
afterEach(async () => {
  while (roots.length > 0) {
    const r = present(roots.pop(), "roots.pop()")
    await rm(r, { recursive: true, force: true })
  }
})

// Sanity anchor for the two consts we assert against — pins the intrinsic
// leaf contract, and guards the §A math (17 > MAX_DEPTH) from silent drift.
describe("owner-local constants", () => {
  test("MAX_BYTES is 64 KiB and candidate order is the documented SSOT", () => {
    expect(MAX_BYTES).toBe(64 * 1024)
    expect(REPO_RULE_CANDIDATES).toEqual(["AGENTS.md", "CLAUDE.md", ".codex/CODEX-RULES.md"])
  })
})

describe("§A MAX_DEPTH=16 is a hard walk-up boundary (no runaway, bounded reach)", () => {
  test("a rule strictly beyond 16 hops is never reached; a rule within reach IS loaded", async () => {
    // A `.git`-less loose chain so only MAX_DEPTH (not `.git`) can stop the walk.
    // Chain depth 20 (> 16). cwd = deepest dir. The walk visits cwd (hop 0) up
    // through hop 15 inclusive — i.e. it reads at most MAX_DEPTH=16 directories
    // (loop `i < MAX_DEPTH`), so a rule at hop 17 is UNREACHABLE.
    const root = await freshRoot("depth")
    const levels = 20
    let dir = root
    const dirAtHop: string[] = [] // dirAtHop[k] = dir k hops ABOVE the deepest cwd
    // Build root/d0/d1/.../d19 and record each; cwd will be the deepest.
    for (let i = 0; i < levels; i++) {
      dir = join(dir, `d${i}`)
      mkdirSync(dir)
    }
    const cwd = dir
    // Walk back UP recording hop distance from cwd.
    let cur = cwd
    for (let hop = 0; hop < levels; hop++) {
      dirAtHop[hop] = cur
      cur = join(cur, "..")
    }
    // Resolve the recorded hop dirs to absolute so writeFile hits the right place.
    // Reconstruct deterministically instead of relying on '..' segments.
    const hopDir = (hop: number): string => {
      // deepest cwd is root/d0/.../d19 ; hop `h` up drops the last `h` segments.
      const keep = levels - hop // number of dN segments to keep
      let p = root
      for (let i = 0; i < keep; i++) p = join(p, `d${i}`)
      return p
    }

    // WITHIN reach: hop 3 (well under 16). Must be loaded — paired positive so a
    // vacuously-empty loader can't pass.
    await writeFile(join(hopDir(3), "AGENTS.md"), "NEAR-RULE-HOP3\n", "utf8")
    // BEYOND reach: hop 17 (> MAX_DEPTH-1=15, so never visited). Must NOT appear.
    await writeFile(join(hopDir(17), "AGENTS.md"), "FAR-RULE-HOP17\n", "utf8")

    // Bound the call so a hypothetical runaway (missing MAX_DEPTH guard) fails
    // loud rather than hanging the suite.
    const out = await Promise.race([
      loadRepoRules(cwd),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("walk did not terminate")), 5000),
      ),
    ])

    expect(out).toBeDefined()
    expect(out?.body).toContain("NEAR-RULE-HOP3") // non-vacuous: near rule loaded
    expect(out?.body ?? "").not.toContain("FAR-RULE-HOP17") // beyond-16 excluded
    // And it must have collected the near layer only (nothing from beyond 16).
    const bodies = (out?.layers ?? []).map((l) => l.body).join("|")
    expect(bodies).toContain("NEAR-RULE-HOP3")
    expect(bodies).not.toContain("FAR-RULE-HOP17")
  })

  test("boundary line: a rule at exactly hop 15 (last visited) IS loaded", async () => {
    // Loop visits i = 0..15 inclusive (16 dirs) ⇒ hop 15 is the last dir read.
    // This pins the inclusive edge so an off-by-one tightening to <15 goes RED.
    const root = await freshRoot("edge")
    let dir = root
    const levels = 18
    for (let i = 0; i < levels; i++) {
      dir = join(dir, `d${i}`)
      mkdirSync(dir)
    }
    const cwd = dir
    const hopDir = (hop: number): string => {
      const keep = levels - hop
      let p = root
      for (let i = 0; i < keep; i++) p = join(p, `d${i}`)
      return p
    }
    await writeFile(join(hopDir(15), "AGENTS.md"), "EDGE-RULE-HOP15\n", "utf8")
    const out = await loadRepoRules(cwd)
    expect(out?.body ?? "").toContain("EDGE-RULE-HOP15")
  })
})

describe("§B `.git` boundary is INCLUDE-then-STOP (parent of repo-root excluded)", () => {
  test("repo-root AGENTS.md loads; a rule in `.git`-root's PARENT does NOT", async () => {
    // outer/  (has AGENTS.md — this is ABOVE the repo root, must be excluded)
    //   repo/ (has `.git` + AGENTS.md — repo root, INCLUDED then stop)
    //     sub/ (cwd)
    const root = await freshRoot("gitstop")
    const outer = join(root, "outer")
    const repo = join(outer, "repo")
    const sub = join(repo, "sub")
    mkdirSync(sub, { recursive: true })
    // `.git` as a file (worktree-style gitlink) — existsSync(join(dir,".git")) is
    // true for a file too, matching the loader's stop check.
    writeFileSync(join(repo, ".git"), "")
    await writeFile(join(outer, "AGENTS.md"), "OUTER-ABOVE-REPO\n", "utf8")
    await writeFile(join(repo, "AGENTS.md"), "REPO-ROOT-INCLUDED\n", "utf8")

    // homeDir far above `root` so the home boundary never fires — only `.git`
    // decides the stop, isolating the edge under test.
    const out = await loadRepoRules(sub, { homeDir: tmpdir() })
    expect(out).toBeDefined()
    expect(out?.body).toContain("REPO-ROOT-INCLUDED") // non-vacuous positive
    expect(out?.body ?? "").not.toContain("OUTER-ABOVE-REPO") // parent excluded
    // Provenance: exactly the repo-root layer, none from outer.
    const sources = (out?.layers ?? []).map((l) => l.sourcePath)
    expect(sources).toContain(join(repo, "AGENTS.md"))
    expect(sources).not.toContain(join(outer, "AGENTS.md"))
  })
})

describe("§C default home boundary path (no opts) on a positive `.git`-rooted load", () => {
  test("loads a `.git`-rooted rule without any opts.homeDir / opts.now injection", async () => {
    // Exercises the `opts = {}` default branch (homeBoundary = homedir(),
    // now = Date.now) that every other walk-up test bypasses via explicit opts.
    // We build the repo UNDER a temp dir; `.git` stops the walk before the
    // default home boundary is ever reached, so the outcome is host-independent
    // yet the default code path is genuinely linked.
    const root = await freshRoot("defhome")
    const repo = join(root, "repo")
    mkdirSync(repo)
    writeFileSync(join(repo, ".git"), "")
    await writeFile(join(repo, "AGENTS.md"), "DEFAULT-HOME-PATH-RULE\n", "utf8")

    const before = Date.now()
    const out = await loadRepoRules(repo) // ← no second arg at all
    const after = Date.now()

    expect(out).toBeDefined()
    // Single-layer body is the RAW file content (loader does not trim on read;
    // only rendered subheaders trim), so the trailing newline survives verbatim.
    expect(out?.body).toBe("DEFAULT-HOME-PATH-RULE\n")
    // Default `now = Date.now` was used (not a pinned stub): timestamp is a real
    // wall-clock reading bracketed by our own reads.
    expect(out?.loadedAt).toBeGreaterThanOrEqual(before)
    expect(out?.loadedAt).toBeLessThanOrEqual(after)
    // The default boundary IS the real homedir (sanity: our temp repo is not it).
    expect(repo).not.toBe(homedir())
  })
})
