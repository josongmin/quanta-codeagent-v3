/**
 * RFC-07 G1 (aug-22 흡수) — exact passive-VCS field extension hellgate.
 *
 * Two AUTHORITATIVE fields added to the already-built passive-VCS classifier:
 *
 *  1. `commit.branch` — the branch literally present in the matched
 *     `[<branch> <sha>]` commit bracket (the classifier already captures only the
 *     sha). Never fabricated: absent/ambiguous/detached-HEAD ⇒ omit.
 *  2. `pr.action` — derived from the exact `gh pr <verb>` argv command-shape
 *     (closed union). Requires exit 0 + an authoritative PR identity (argv PR
 *     number OR stdout URL/#N). Ambiguous/conflicting/read-only/heredoc ⇒ omit.
 *
 * Discipline mirrored from the existing classifier hellgate: authoritative-only,
 * command-shape gating (never a stdout scrape for the verb), omit-on-ambiguity,
 * and red-on-injection (a commit WITHOUT a bracket must NOT invent a branch; an
 * ambiguous gh argv must NOT guess an action).
 */
import { describe, expect, test } from "bun:test"
import { classifyPassiveVcs } from "@/git/passive-classify"
import { parseGhPrCommand, type VcsPrAction } from "@/git/passive-classify/pr-action"

const ok0 = (command: string, stdout: string) =>
  classifyPassiveVcs({ command, stdout, exitCode: 0 })

const idOut = (n: number) => `https://github.com/owner/repo/pull/${n}`

/* ================================================================== */
/*  1. commit.branch — literal bracket field                          */
/* ================================================================== */

describe("commit.branch — literal `[<branch> <sha>]` bracket field", () => {
  test("G1-BR1: plain commit `[feat/x 9d5369d]` → commit.branch 'feat/x'", () => {
    const ev = ok0("git commit -m x", "[feat/x 9d5369d] add thing")
    expect(ev?.commit).toEqual({ kind: "commit", sha: "9d5369d", branch: "feat/x" })
  })

  test("G1-BR2: simple branch name `[main abc1234]` → 'main'", () => {
    const ev = ok0("git commit -m x", "[main abc1234] subject")
    expect(ev?.commit?.branch).toBe("main")
  })

  test("G1-BR3: root-commit parenthetical stripped `[main (root-commit) abc1234]` → 'main'", () => {
    const ev = ok0("git commit -m init", "[main (root-commit) abcd123] init")
    expect(ev?.commit?.branch).toBe("main")
  })

  test("G1-BR4: `(N commits)` parenthetical stripped → branch only", () => {
    const ev = ok0("git commit -m x", "[release/2 (2 commits) abc1234] squash")
    expect(ev?.commit?.branch).toBe("release/2")
  })

  test("G1-BR5: detached HEAD → NO branch (omitted, never guessed)", () => {
    const ev = ok0("git commit -m wip", "[detached HEAD f00ba12] wip")
    expect(ev?.commit?.sha).toBe("f00ba12")
    expect(ev?.commit?.branch).toBeUndefined()
  })

  test("G1-BR6: merge commit bracket carries the branch too", () => {
    const out = ["Merge made by the 'ort' strategy.", "[main 9f8e7d6] Merge branch 'feature'"].join(
      "\n",
    )
    const ev = ok0("git merge --no-ff feature", out)
    expect(ev?.commit).toEqual({ kind: "merge", sha: "9f8e7d6", branch: "main" })
  })

  test("G1-BR7: cherry-pick bracket carries the branch too", () => {
    const ev = ok0("git cherry-pick 7a8b9c0", "[topic 7a8b9c0] Fix: the thing")
    expect(ev?.commit).toEqual({ kind: "cherry-pick", sha: "7a8b9c0", branch: "topic" })
  })

  // ── RED-ON-INJECTION: no bracket ⇒ NO fabricated branch ──────────────────────
  test("G1-BR8 (red-on-injection): amend --quiet with NO bracket → NO branch fabricated", () => {
    const ev = ok0("git commit --amend --quiet --no-edit", "")
    expect(ev?.commit).toEqual({ kind: "amend" })
    expect(ev?.commit?.branch).toBeUndefined()
  })

  test("G1-BR9 (red-on-injection): sha only via 'HEAD is now at' (no bracket) → NO branch", () => {
    const ev = ok0("git commit --amend", "HEAD is now at abc1234 prior subject")
    // amend with no bracket ⇒ kind amend, no sha (HEAD-now-at is a secondary sha
    // source only for reset), and crucially NO branch.
    expect(ev?.commit?.branch).toBeUndefined()
  })

  test("G1-BR10 (red-on-injection): ambiguous two-token prefix → omit (never guess)", () => {
    // A bracket whose prefix still has whitespace after paren-strip is ambiguous;
    // omit rather than pick a token.
    const ev = ok0("git commit -m x", "[weird prefix abc1234] x")
    expect(ev?.commit?.branch).toBeUndefined()
  })
})

/* ================================================================== */
/*  2. pr.action — exact `gh pr <verb>` argv grammar                   */
/* ================================================================== */

describe("pr.action — exact gh pr argv grammar (positive rows)", () => {
  test("G1-PR-create: `gh pr create` → created", () => {
    const ev = ok0("gh pr create --fill", idOut(4242))
    expect(ev?.pr).toEqual({ number: 4242, url: idOut(4242), action: "created" })
  })

  test("G1-PR-edit: `gh pr edit 5` → edited", () => {
    const ev = ok0("gh pr edit 5 --title new", "")
    expect(ev?.pr).toEqual({ number: 5, action: "edited" })
  })

  test("G1-PR-merge: `gh pr merge 17` (no auto flags) → merged", () => {
    const ev = ok0("gh pr merge 17 --squash", "Pull request #17 successfully merged.")
    expect(ev?.pr).toEqual({ number: 17, action: "merged" })
  })

  test("G1-PR-comment: `gh pr comment 5` → commented", () => {
    const ev = ok0("gh pr comment 5 --body hi", "")
    expect(ev?.pr).toEqual({ number: 5, action: "commented" })
  })

  test("G1-PR-close: `gh pr close 6` → closed", () => {
    const ev = ok0("gh pr close 6", "")
    expect(ev?.pr).toEqual({ number: 6, action: "closed" })
  })

  test("G1-PR-reopen: `gh pr reopen 412` → reopened (REQUIRED rail; identity from argv)", () => {
    const ev = ok0("gh pr reopen 412", "")
    expect(ev?.pr).toEqual({ number: 412, action: "reopened" })
  })

  test("G1-PR-ready: `gh pr ready 9` (no --undo) → ready", () => {
    const ev = ok0("gh pr ready 9", "")
    expect(ev?.pr).toEqual({ number: 9, action: "ready" })
  })

  test("G1-PR-draft: `gh pr ready 9 --undo` → draft", () => {
    const ev = ok0("gh pr ready 9 --undo", "")
    expect(ev?.pr).toEqual({ number: 9, action: "draft" })
  })

  test("G1-PR-auto-enable: `gh pr merge 3 --auto` → auto-merge-enabled", () => {
    const ev = ok0("gh pr merge 3 --auto --squash", "")
    expect(ev?.pr).toEqual({ number: 3, action: "auto-merge-enabled" })
  })

  test("G1-PR-auto-disable: `gh pr merge 3 --disable-auto` → auto-merge-disabled", () => {
    const ev = ok0("gh pr merge 3 --disable-auto", "")
    expect(ev?.pr).toEqual({ number: 3, action: "auto-merge-disabled" })
  })
})

describe("pr.action — adversarial / omission (never guess)", () => {
  test("G1-PR-conflict: `gh pr merge 3 --auto --disable-auto` → NO action, NO facet", () => {
    // Conflicting flags drop the action; an argv number alone never invents a
    // facet (same rule as a read-only verb), so with no stdout identity there is
    // no pr facet at all.
    const ev = ok0("gh pr merge 3 --auto --disable-auto", "")
    expect(ev).toBeNull()
  })

  test("G1-PR-conflict-with-stdout-id: conflicting flags but stdout identity → identity kept, NO action", () => {
    const ev = ok0("gh pr merge 3 --auto --disable-auto", "https://github.com/o/r/pull/3")
    expect(ev?.pr?.number).toBe(3)
    expect(ev?.pr?.action).toBeUndefined()
  })

  test("G1-PR-readonly-view: `gh pr view 9` (no stdout id) → NO facet at all", () => {
    const ev = ok0("gh pr view 9", "")
    expect(ev).toBeNull()
  })

  test("G1-PR-readonly-verbs: list/status/checks/diff (with stdout id) → identity, NO action", () => {
    for (const verb of ["list", "status", "checks", "diff"]) {
      const ev = ok0(`gh pr ${verb} 9`, "https://github.com/o/r/pull/9")
      expect(ev?.pr?.number).toBe(9)
      expect(ev?.pr?.action).toBeUndefined()
    }
  })

  test("G1-PR-absent-identity: `gh pr reopen` with NO number and NO stdout id → NO facet", () => {
    const ev = ok0("gh pr reopen", "")
    expect(ev).toBeNull()
  })

  test("G1-PR-ambiguous-chain: two gh pr segments → NO action (ambiguous)", () => {
    const ev = ok0("gh pr create --fill && gh pr merge 5 --auto", "https://github.com/o/r/pull/7")
    // stdout identity still yields the PR number, but the verb is ambiguous.
    expect(ev?.pr?.number).toBe(7)
    expect(ev?.pr?.action).toBeUndefined()
  })

  test("G1-PR-quoted-string: verb inside a quoted flag value does NOT hijack the action", () => {
    const ev = ok0('gh pr comment 5 --body "please gh pr close this"', "")
    expect(ev?.pr).toEqual({ number: 5, action: "commented" })
  })

  test("G1-PR-comment-hash: `# gh pr close 6` trailing comment does NOT hijack", () => {
    const ev = ok0("gh pr reopen 6 # gh pr close 6", "")
    expect(ev?.pr).toEqual({ number: 6, action: "reopened" })
  })

  test("G1-PR-echo (red-on-injection): echo of a gh pr command → NO event", () => {
    const ev = ok0('echo "gh pr create --fill"', "https://github.com/o/r/pull/1")
    expect(ev).toBeNull()
  })

  test("G1-PR-alias (red-on-injection): unknown subcommand (not `pr`) → NO action", () => {
    const ev = ok0("gh prc 5", "")
    expect(ev).toBeNull()
  })

  test("G1-PR-failed-exit: nonzero exit → whole event null (no action)", () => {
    const ev = classifyPassiveVcs({
      command: "gh pr merge 5 --squash",
      stdout: "Pull request #5 successfully merged.",
      exitCode: 1,
    })
    expect(ev).toBeNull()
  })

  test("G1-PR-unknown-verb: `gh pr foobar 5` → NO action (identity from stdout only)", () => {
    const ev = ok0("gh pr foobar 5", "https://github.com/o/r/pull/5")
    expect(ev?.pr?.number).toBe(5)
    expect(ev?.pr?.action).toBeUndefined()
  })
})

/* ================================================================== */
/*  3. pure grammar unit (parseGhPrCommand) — exhaustive verb table   */
/* ================================================================== */

describe("parseGhPrCommand — pure token grammar", () => {
  test("G1-GR-table: every admitted argv maps to its exact action", () => {
    const table: ReadonlyArray<readonly [string, VcsPrAction]> = [
      ["gh pr create --fill", "created"],
      ["gh pr edit 5", "edited"],
      ["gh pr merge 5", "merged"],
      ["gh pr comment 5 --body x", "commented"],
      ["gh pr close 5", "closed"],
      ["gh pr reopen 5", "reopened"],
      ["gh pr ready 5", "ready"],
      ["gh pr ready 5 --undo", "draft"],
      ["gh pr merge 5 --auto", "auto-merge-enabled"],
      ["gh pr merge 5 --disable-auto", "auto-merge-disabled"],
    ]
    for (const [cmd, action] of table) {
      expect(parseGhPrCommand(cmd)?.action).toBe(action)
    }
  })

  test("G1-GR-number: explicit argv PR number is extracted right after the verb", () => {
    expect(parseGhPrCommand("gh pr reopen 412")?.number).toBe(412)
    expect(parseGhPrCommand("gh pr merge 5 --auto")?.number).toBe(5)
    // create takes no PR selector ⇒ no number.
    expect(parseGhPrCommand("gh pr create --fill")?.number).toBeUndefined()
  })

  test("G1-GR-null: non-gh / non-pr / ambiguous / malformed ⇒ null", () => {
    expect(parseGhPrCommand("git commit -m x")).toBeNull()
    expect(parseGhPrCommand("gh repo view")).toBeNull()
    expect(parseGhPrCommand("gh pr")).toBeNull() // no verb
    expect(parseGhPrCommand("gh pr create && gh pr merge 5")).toBeNull() // ambiguous
    expect(parseGhPrCommand('gh pr comment 5 --body "unterminated')).toBeNull() // malformed quote
  })

  test("G1-GR-env-prefix: env-var prefixed gh is recognized", () => {
    expect(parseGhPrCommand("GH_TOKEN=x gh pr close 8")?.action).toBe("closed")
  })
})
