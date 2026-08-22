/**
 * hell-audit Round-5/6 — loadRepoRules walk-up boundary behavior.
 *
 * WS4 renders repo-local rules (AGENTS.md/CLAUDE.md) as TRUSTED system-prompt
 * "Rules", so the cwd→root walk must (a) stop climbing above the user's home on
 * a `.git`-less loose dir (shared-box hygiene) yet (b) NOT over-block a benign
 * in-repo symlinked directory (Round-5's lexical symlink-stop regressed this and
 * had bypasses of its own — see R6 audit; the real injection defense for
 * untrusted surfaces is MODE_REPO_RULES_POLICY (rule-less), and symlinked rule FILES stay rejected
 * by the loader's existing `lstat`).
 *
 *   §1 (M-C) a benign in-repo symlinked dir does NOT hide the repo-root rules.
 *   §2 (M1)  the walk stops AT the home boundary, case-insensitively (H1-B).
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

describe("Round-6 §1 (M-C) — a benign in-repo symlinked dir does not hide repo-root rules", () => {
  test("walk-up through an in-repo dir-symlink still reaches the repo-root AGENTS.md", async () => {
    // repo/ (has .git + root rules) ; repo/link -> repo/realdir (BOTH in-repo).
    const repo = join(root, "repo")
    mkdirSync(repo)
    writeFileSync(join(repo, ".git"), "")
    writeFileSync(join(repo, "AGENTS.md"), "# repo\nREPO-ROOT-RULES\n")
    mkdirSync(join(repo, "realdir", "leaf"), { recursive: true })
    symlinkSync(join(repo, "realdir"), join(repo, "link"), "dir")

    // Working under a benign in-repo symlink must NOT sever the walk (Round-5's
    // lexical symlink-stop broke exactly this).
    const rules = await loadRepoRules(join(repo, "link", "leaf"), { homeDir: root })
    expect(rules?.body ?? "").toContain("REPO-ROOT-RULES")
  })
})

describe("Round-6 §2 (M1) — the walk-up stops at the home boundary (case-insensitive)", () => {
  const setup = (): string => {
    // No `.git` anywhere. An AGENTS.md sits AT the boundary and must NOT be
    // pulled into a deeper cwd's rules; an in-project ancestor is fine.
    writeFileSync(join(root, "AGENTS.md"), "# home\nABOVE-HOME-INJECTED\n")
    const deep = join(root, "loose", "a", "b")
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(root, "loose", "a", "AGENTS.md"), "# in-project\nPROJECT-RULES\n")
    return deep
  }

  test("exact home boundary stops the walk", async () => {
    const deep = setup()
    const rules = await loadRepoRules(deep, { homeDir: root })
    const body = rules?.body ?? ""
    expect(body).toContain("PROJECT-RULES")
    expect(body).not.toContain("ABOVE-HOME-INJECTED")
  })

  test("a case-fold spelling of the home boundary ALSO stops (macOS/APFS bypass)", async () => {
    const deep = setup()
    // Same dir, upper-cased spelling — an exact-string boundary check would miss.
    const rules = await loadRepoRules(deep, { homeDir: root.toUpperCase() })
    expect(rules?.body ?? "").not.toContain("ABOVE-HOME-INJECTED")
  })
})
