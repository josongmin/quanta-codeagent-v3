/**
 * hell-audit Round-5 — loadRepoRules walk-up boundary hardening.
 *
 * WS4 wired repo-local rules (AGENTS.md/CLAUDE.md) into the TRUSTED system prompt
 * for human-driven presets. That raised the trust bar on `loadRepoRules`'
 * cwd→root walk: any rule file it reads becomes authoritative "Rules". Two
 * walk-up escapes let content OUTSIDE the intended repo in:
 *
 *   §1 (H1) SYMLINKED ANCESTOR — `lstat` rejected a symlinked rule FILE, but a
 *      symlinked DIRECTORY in the walk-up path was traversed transparently, so
 *      `repo/sub/AGENTS.md` (where `sub` → an out-of-repo dir) was read as repo
 *      policy. Fix: stop the walk at a symlinked ancestor.
 *   §2 (M1) ABOVE-$HOME — with no `.git` anywhere, the walk climbed to fs-root,
 *      absorbing ancestor AGENTS.md ($HOME / shared parents) on multi-user boxes.
 *      Fix: stop the walk at the home boundary (never read at/above it).
 *
 * Red-on-injection: revert either guard ⇒ the out-of-boundary sentinel appears.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRepoRules } from "@/agent/repo-rules"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omo-walkup-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("Round-5 §1 (H1) — a symlinked ancestor directory is NOT traversed", () => {
  test("rules behind a dir-symlink escaping the repo are never read", () => {
    // repo/ (real, has .git + its own rules) ; repo/sub -> /outside (attacker).
    const repo = join(root, "repo")
    mkdirSync(repo)
    writeFileSync(join(repo, ".git"), "")
    writeFileSync(join(repo, "AGENTS.md"), "# repo\nREPO-OWN-RULES\n")
    const outside = join(root, "outside")
    mkdirSync(outside)
    writeFileSync(join(outside, "AGENTS.md"), "# evil\nOUTSIDE-INJECTED-RULES\n")
    mkdirSync(join(outside, "deep"))
    symlinkSync(outside, join(repo, "sub"), "dir")

    // Run inside the symlinked subtree: repo/sub/deep == outside/deep.
    const cwd = join(repo, "sub", "deep")
    return loadRepoRules(cwd).then((rules) => {
      const body = rules?.body ?? ""
      expect(body).not.toContain("OUTSIDE-INJECTED-RULES")
    })
  })
})

describe("Round-5 §2 (M1) — the walk-up stops at the home boundary", () => {
  test("a .git-less loose dir does NOT absorb an ancestor's (home) AGENTS.md", () => {
    // No `.git` anywhere. `root` acts as the home boundary; an AGENTS.md sits AT
    // the boundary and MUST NOT be pulled into a deeper cwd's rules.
    writeFileSync(join(root, "AGENTS.md"), "# home\nABOVE-HOME-INJECTED\n")
    const deep = join(root, "loose", "a", "b")
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(root, "loose", "a", "AGENTS.md"), "# in-project\nPROJECT-RULES\n")

    return loadRepoRules(deep, { homeDir: root }).then((rules) => {
      const body = rules?.body ?? ""
      // In-project ancestor is fine …
      expect(body).toContain("PROJECT-RULES")
      // … but the at/above-home file is NOT absorbed.
      expect(body).not.toContain("ABOVE-HOME-INJECTED")
    })
  })
})
