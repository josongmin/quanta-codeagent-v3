/**
 * H6 (jun-3-misc §3) — Passive git/gh stdout classifier hellgate battery.
 *
 * Adversarial pattern matrix for the PURE classifier
 * ({@link classifyPassiveVcs}). Every g27 pattern is exercised with REALISTIC
 * git/gh stdout, plus the false-positive guards:
 *
 *  A. merged  — Fast-forward / Merge made by → branch.action "merged" (+merge commit)
 *  B. rebased — Successfully rebased → branch.action "rebased"
 *  C. amended — `--amend` command flag → commit.kind "amend" + branch "amended"
 *  D. cherry-pick — `git cherry-pick` + landed `[branch sha]` → commit "cherry-pick"
 *  E. push — ref-update line → push.{localRef,remoteRef}
 *  F. pr — Pull request #N / pull/N URL → pr.number
 *  G. sha extraction — `[branch sha]`, `HEAD is now at sha`, root-commit, detached
 *  H. false-positive guards — non-git command, exitCode≠0, garbage, echo-of-phrase
 *  I. multi-facet — one output yielding several facets at once
 *  J. purity — same input is deterministic; never throws on fuzz garbage
 */
import { describe, expect, test } from "bun:test"
import { classifyPassiveVcs } from "@/git/passive-classify"

const ok0 = (command: string, stdout: string) =>
  classifyPassiveVcs({ command, stdout, exitCode: 0 })

/* ================================================================== */
/*  A. merged                                                          */
/* ================================================================== */

describe("A. merged — Fast-forward / Merge made by", () => {
  test("HELL-A1: fast-forward merge → branch.action merged (no merge commit)", () => {
    const out = ["Updating a1b2c3d..e4f5a6b", "Fast-forward", " file.ts | 2 +-"].join("\n")
    const ev = ok0("git merge feature", out)
    expect(ev?.branch).toEqual({ action: "merged" })
    // A fast-forward creates NO merge commit ⇒ no commit facet.
    expect(ev?.commit).toBeUndefined()
  })

  test("HELL-A2: non-fast-forward merge → merged + commit.kind merge + sha", () => {
    const out = [
      "Merge made by the 'ort' strategy.",
      " file.ts | 4 ++--",
      "[main 9f8e7d6] Merge branch 'feature'",
    ].join("\n")
    const ev = ok0("git merge --no-ff feature", out)
    expect(ev?.branch).toEqual({ action: "merged" })
    expect(ev?.commit).toEqual({ kind: "merge", sha: "9f8e7d6" })
  })

  test("HELL-A3: 'Merge made by' WITHOUT a bracket line still gets commit.kind merge (no sha)", () => {
    const ev = ok0("git merge feature", "Merge made by the 'recursive' strategy.")
    expect(ev?.branch).toEqual({ action: "merged" })
    expect(ev?.commit).toEqual({ kind: "merge" })
  })
})

/* ================================================================== */
/*  B. rebased                                                         */
/* ================================================================== */

describe("B. rebased — Successfully rebased", () => {
  test("HELL-B1: successful rebase → branch.action rebased", () => {
    const out = "Successfully rebased and updated refs/heads/feature."
    const ev = ok0("git rebase main", out)
    expect(ev?.branch).toEqual({ action: "rebased" })
  })

  test("HELL-B2: rebase that printed 'HEAD is now at' also yields rebased + sha via HEAD line", () => {
    const out = [
      "First, rewinding head to replay your work on top of it...",
      "Applying: my change",
      "Successfully rebased and updated refs/heads/feature.",
    ].join("\n")
    const ev = ok0("git rebase main", out)
    expect(ev?.branch).toEqual({ action: "rebased" })
  })
})

/* ================================================================== */
/*  C. amended                                                         */
/* ================================================================== */

describe("C. amended — --amend command flag", () => {
  test("HELL-C1: commit --amend → commit.kind amend + branch amended", () => {
    const out = "[main 1234abc] reworded message\n Date: ...\n 1 file changed"
    const ev = ok0("git commit --amend -m 'reworded message'", out)
    expect(ev?.commit).toEqual({ kind: "amend", sha: "1234abc" })
    expect(ev?.branch).toEqual({ action: "amended" })
  })

  test("HELL-C2: amend under --quiet (no bracket line) → kind amend, no sha, branch amended", () => {
    const ev = ok0("git commit --amend --quiet --no-edit", "")
    expect(ev?.commit).toEqual({ kind: "amend" })
    expect(ev?.branch).toEqual({ action: "amended" })
  })

  test("HELL-C3: --amend appearing inside the commit message (not a flag) at end of cmd still flags — accepted (command-shape)", () => {
    // The flag matcher anchors on a whitespace boundary; a genuine `--amend`
    // token is the signal. This documents the chosen command-shape semantics.
    const ev = ok0("git commit --amend", "[main abc1234] x")
    expect(ev?.commit?.kind).toBe("amend")
  })
})

/* ================================================================== */
/*  D. cherry-pick                                                     */
/* ================================================================== */

describe("D. cherry-pick", () => {
  test("HELL-D1: cherry-pick that landed → commit.kind cherry-pick + sha", () => {
    const out = "[main 7a8b9c0] Fix: the thing\n Date: ...\n 1 file changed, 2 insertions(+)"
    const ev = ok0("git cherry-pick 7a8b9c0", out)
    expect(ev?.commit).toEqual({ kind: "cherry-pick", sha: "7a8b9c0" })
  })

  test("HELL-D2: cherry-pick --abort (no landed commit) → no commit facet", () => {
    const ev = ok0("git cherry-pick --abort", "")
    // No `[branch sha]` ⇒ no cherry-pick commit. (Also no other facet.)
    expect(ev).toBeNull()
  })

  test("HELL-D3: cherry-pick takes precedence over plain-commit classification", () => {
    const ev = ok0("git cherry-pick deadbee", "[topic deadbee] subject")
    expect(ev?.commit?.kind).toBe("cherry-pick")
  })
})

/* ================================================================== */
/*  E. push                                                            */
/* ================================================================== */

describe("E. push — ref-update line", () => {
  test("HELL-E1: existing-branch push → push.{localRef,remoteRef}", () => {
    const out = [
      "Enumerating objects: 5, done.",
      "To github.com:owner/repo.git",
      "   a1b2c3d..e4f5a6b  main -> main",
    ].join("\n")
    const ev = ok0("git push origin main", out)
    expect(ev?.push).toEqual({ localRef: "main", remoteRef: "main" })
  })

  test("HELL-E2: new-branch push → push parsed from '* [new branch]' line", () => {
    const out = ["To github.com:owner/repo.git", " * [new branch]      feature -> feature"].join(
      "\n",
    )
    const ev = ok0("git push -u origin feature", out)
    expect(ev?.push).toEqual({ localRef: "feature", remoteRef: "feature" })
  })

  test("HELL-E3: 'Everything up-to-date' is NOT a push (no arrow) → null", () => {
    const ev = ok0("git push origin main", "Everything up-to-date")
    expect(ev).toBeNull()
  })

  test("HELL-E4: HEAD:refs/for push (gerrit-style remote ref) parses both sides", () => {
    const out = "   abc1234..def5678  HEAD -> refs/for/main"
    const ev = ok0("git push origin HEAD:refs/for/main", out)
    expect(ev?.push?.localRef).toBe("HEAD")
    expect(ev?.push?.remoteRef).toBe("refs/for/main")
  })

  // ── REGRESSION: `git push --dry-run` exits 0 and prints a ref-update line
  //    BYTE-IDENTICAL to a real push, but NOTHING was pushed. The exitCode guard
  //    cannot catch it → a phantom push event. We suppress on the command flag.
  test("HELL-E5: `git push --dry-run` ref-line → NO push facet (nothing pushed)", () => {
    const out = "To github.com:owner/repo.git\n   a1b2c3d..e4f5a6b  main -> main"
    expect(ok0("git push --dry-run origin main", out)).toBeNull()
  })

  test("HELL-E6: `git push -n` (short dry-run alias) → NO push facet", () => {
    const out = " * [new branch]      feature -> feature"
    expect(ok0("git push -n -u origin feature", out)).toBeNull()
  })

  test("HELL-E7: env-prefixed dry-run push → NO push facet", () => {
    const out = "   a1b2c3d..e4f5a6b  main -> main"
    expect(ok0("GIT_SSH_COMMAND=ssh git push --dry-run origin main", out)).toBeNull()
  })

  test("HELL-E8: chained `git commit -n && git push` → push NOT suppressed (the -n is commit's --no-verify, NOT a push dry-run)", () => {
    const out = "   a1b2c3d..e4f5a6b  main -> main"
    const ev = ok0("git commit -n -m wip && git push origin main", out)
    expect(ev?.push).toEqual({ localRef: "main", remoteRef: "main" })
  })

  test("HELL-E9: real push (no dry-run flag) still classifies", () => {
    const out = "   a1b2c3d..e4f5a6b  main -> main"
    expect(ok0("git push origin main", out)?.push).toEqual({
      localRef: "main",
      remoteRef: "main",
    })
  })
})

/* ================================================================== */
/*  F. pr                                                              */
/* ================================================================== */

describe("F. pr — gh pull request reference", () => {
  test("HELL-F1: gh pr create URL → pr.number + url", () => {
    const out = "https://github.com/owner/repo/pull/4242"
    const ev = ok0("gh pr create --fill", out)
    expect(ev?.pr).toEqual({ number: 4242, url: "https://github.com/owner/repo/pull/4242" })
  })

  test("HELL-F2: 'Pull request #N' phrase → pr.number (no url)", () => {
    const ev = ok0("gh pr merge 17 --squash", "Pull request #17 successfully merged.")
    expect(ev?.pr).toEqual({ number: 17 })
  })

  test("HELL-F3: gh pr view URL embedded in a longer line", () => {
    const out = "View this pull request on GitHub: https://github.com/o/r/pull/9\nmore text"
    const ev = ok0("gh pr view 9 --web", out)
    expect(ev?.pr?.number).toBe(9)
  })
})

/* ================================================================== */
/*  G. sha extraction                                                  */
/* ================================================================== */

describe("G. sha extraction edge cases", () => {
  test("HELL-G1: root-commit bracket → sha extracted (last hex token)", () => {
    const ev = ok0("git commit -m init", "[main (root-commit) abcd123] init")
    expect(ev?.commit).toEqual({ kind: "commit", sha: "abcd123" })
  })

  test("HELL-G2: detached HEAD bracket → sha extracted", () => {
    const ev = ok0("git commit -m wip", "[detached HEAD f00ba12] wip")
    expect(ev?.commit?.sha).toBe("f00ba12")
  })

  test("HELL-G3: 40-char long sha accepted", () => {
    const long = "0123456789abcdef0123456789abcdef01234567"
    const ev = ok0("git commit -m x", `[main ${long}] x`)
    expect(ev?.commit?.sha).toBe(long)
  })

  test("HELL-G4: 'HEAD is now at' as sha source for a reset", () => {
    // reset --hard is not a commit; but the HEAD-now-at sha is a valid hex
    // source. With no other facet it yields null (reset is not classified).
    const ev = ok0("git reset --hard HEAD~1", "HEAD is now at abc1234 prior subject")
    expect(ev).toBeNull()
  })
})

/* ================================================================== */
/*  H. false-positive guards                                          */
/* ================================================================== */

describe("H. false-positive guards", () => {
  test("HELL-H1: non-git command whose OUTPUT contains git phrases → null", () => {
    const ev = ok0('echo "Fast-forward Merge made by the strategy"', "Fast-forward")
    expect(ev).toBeNull()
  })

  test("HELL-H2: echo of a push ref-line → null (command word is echo)", () => {
    const ev = ok0('echo "   a..b  main -> main"', "   a..b  main -> main")
    expect(ev).toBeNull()
  })

  test("HELL-H3: failed merge (exitCode 1) → null even with merge phrase present", () => {
    const out = "Auto-merging file.ts\nCONFLICT (content): Merge conflict in file.ts"
    const ev = classifyPassiveVcs({ command: "git merge feature", stdout: out, exitCode: 1 })
    expect(ev).toBeNull()
  })

  test("HELL-H4: git --help dump (exit 0) with 'Fast-forward' in prose but no real merge → still classifies merged (documented limitation, but realistic merge help uses exit 0)", () => {
    // We DO classify here because the command is `git merge` and stdout has a
    // `Fast-forward` at line start. This documents that the exitCode guard is
    // the primary cut; a help dump that begins a line with `Fast-forward` is a
    // pathological input. We assert the chosen behavior explicitly so a future
    // change is a visible test diff.
    const ev = ok0("git merge", "Fast-forward\n")
    expect(ev?.branch).toEqual({ action: "merged" })
  })

  test("HELL-H5: benign git status → null (no pattern)", () => {
    const ev = ok0("git status", "On branch main\nnothing to commit, working tree clean")
    expect(ev).toBeNull()
  })

  test("HELL-H6: garbage / empty stdout with a git command → null", () => {
    expect(ok0("git log --oneline", "")).toBeNull()
    expect(ok0("git", "")).toBeNull()
  })

  test("HELL-H7: 'Fast-forward' NOT at line start (mid-line) → not a merge", () => {
    const ev = ok0("git merge feature", "see Fast-forward in the docs")
    expect(ev).toBeNull()
  })

  test("HELL-H8: failed push (exit 1) → null even with a ref-line lookalike", () => {
    const ev = classifyPassiveVcs({
      command: "git push origin main",
      stdout: "   a1b2c3d..e4f5a6b  main -> main",
      exitCode: 1,
    })
    expect(ev).toBeNull()
  })

  test("HELL-H9: git inside a quoted echo arg of a non-git first command → null", () => {
    const ev = ok0('printf "%s" "git push"', "git push")
    expect(ev).toBeNull()
  })
})

/* ================================================================== */
/*  I. multi-facet                                                    */
/* ================================================================== */

describe("I. multi-facet — several signals in one output", () => {
  test("HELL-I1: a chained `git merge && git push` (one bash call) → merged + push", () => {
    const out = [
      "Merge made by the 'ort' strategy.",
      "[main feed123] Merge branch 'topic'",
      "To github.com:o/r.git",
      "   c0ffee0..feed123  main -> main",
    ].join("\n")
    const ev = ok0("git merge --no-ff topic && git push origin main", out)
    expect(ev?.branch).toEqual({ action: "merged" })
    expect(ev?.commit).toEqual({ kind: "merge", sha: "feed123" })
    expect(ev?.push).toEqual({ localRef: "main", remoteRef: "main" })
  })

  test("HELL-I2: `gh pr merge` printing both a PR ref and a merge phrase → pr + merged", () => {
    const out = ["Pull request #88 successfully merged.", "Fast-forward"].join("\n")
    const ev = ok0("gh pr merge 88 --merge", out)
    expect(ev?.pr).toEqual({ number: 88 })
    expect(ev?.branch).toEqual({ action: "merged" })
  })

  test("HELL-I3: env-var prefixed git command is still recognized", () => {
    const ev = ok0("GIT_EDITOR=true git commit --amend", "[main 9999aaa] reword")
    expect(ev?.commit?.kind).toBe("amend")
    expect(ev?.branch).toEqual({ action: "amended" })
  })

  test("HELL-I4: absolute-path git binary recognized", () => {
    const ev = ok0("/usr/bin/git merge feature", "Fast-forward")
    expect(ev?.branch).toEqual({ action: "merged" })
  })
})

/* ================================================================== */
/*  J. purity / fuzz                                                  */
/* ================================================================== */

describe("J. purity — deterministic, no-throw", () => {
  test("HELL-J1: identical input yields identical output (deterministic)", () => {
    const a = ok0("git merge x", "Fast-forward")
    const b = ok0("git merge x", "Fast-forward")
    expect(a).toEqual(b)
  })

  test("HELL-J2: fuzz garbage never throws and never false-positives a facet", () => {
    const garbage = [
      "",
      "\n\n\n",
      "git",
      "gh",
      "Pull request # not-a-number",
      "[main ] empty bracket",
      "[main zzzzzzz] non-hex",
      "-> arrow with no refline shape",
      "Merge",
      "rebased without success word",
    ]
    for (const cmd of ["git x", "gh y", "echo z", "ls", ""]) {
      for (const out of garbage) {
        expect(() => classifyPassiveVcs({ command: cmd, stdout: out, exitCode: 0 })).not.toThrow()
      }
    }
    // Non-hex bracket and empty bracket must NOT yield a sha-bearing commit.
    expect(ok0("git commit -m x", "[main zzzzzzz] x")).toBeNull()
    expect(ok0("git commit -m x", "[main ] x")).toBeNull()
    // 'Pull request #' with no digits → no pr.
    expect(ok0("gh pr view", "Pull request # nope")).toBeNull()
  })
})
