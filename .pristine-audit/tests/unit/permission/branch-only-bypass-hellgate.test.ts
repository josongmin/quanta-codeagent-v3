/**
 * HELLGATE — branch-only git-write guard (ci-bot mode): protected-branch
 * WRITE BYPASS vectors.
 *
 * `branch-only.test.ts` locks the direct cases (explicit refspec push,
 * bare-push-from-main, positional wildcard refspec, commit/merge/rebase/reset
 * to an explicit protected ref). This battery seals THREE documented audit
 * fixes that had NO regression test — each is a way to clobber a protected
 * branch that slips past the obvious checks:
 *
 *   1. `-c alias.<x>=push` CONFIG INJECTION (Audit R2) — the visible
 *      subcommand is the alias name, not `push`; `gitSubcommand` would classify
 *      it as benign. An unresolvable alias under branch-only must fail closed.
 *   2. `--all` / `--mirror` / `--tags` WHOLESALE push (audit fix) — these push
 *      refs wholesale (every branch incl. main) with NO positional refspec, so
 *      the positional `targetsProtectedBranch` scan never sees a protected
 *      token. (Distinct from the H3 POSITIONAL-glob case already covered.)
 *   3. bare destructive `reset --hard HEAD~N` / `git reset --hard` on a
 *      protected current branch (Audit L8 H1) — rewrites the protected
 *      branch's OWN history without ever naming a protected ref, so the
 *      explicit-ref scan misses it.
 *
 * RED-ON-INJECTION (teeth, verified in-session): removing each guard
 * (`hasAliasConfigInjection`, the `isWildcardPush` flag-scan, the
 * `isDestructive && protected currentBranch` reset branch) flips its case from
 * DENY to ALLOW — re-opening the bypass.
 */

import { describe, expect, test } from "bun:test"
import { decideBranchOnly } from "@/../src/permission/branch-only"

const denied = (v: ReturnType<typeof decideBranchOnly>): boolean => v.allowed === false

describe("HELLGATE: branch-only — `-c alias.*=push` config injection cannot smuggle a protected push", () => {
  test("`git -c alias.x=push x origin main` is DENIED (alias hides the push subcommand)", () => {
    const v = decideBranchOnly("git -c alias.x=push x origin main")
    expect(denied(v)).toBe(true)
    if (!v.allowed) expect(v.reason).toMatch(/alias/i)
  })

  test("the glued `-calias.x=push` form is ALSO denied", () => {
    expect(denied(decideBranchOnly("git -calias.x=push x origin main"))).toBe(true)
  })

  test("`--config-env=alias.*` injection is denied", () => {
    expect(denied(decideBranchOnly("git --config-env=alias.x=PUSHVAR x origin main"))).toBe(true)
  })

  test("NO over-correction: a legitimate non-alias `-c` config flag still classifies the real subcommand", () => {
    // `git -c user.name=ci commit` on a FEATURE branch is fine — the `-c` skip
    // must not itself trigger the alias denial.
    const v = decideBranchOnly("git -c user.name=ci commit -m x", undefined, "feature/x")
    expect(v.allowed).toBe(true)
  })
})

describe("HELLGATE: branch-only — `--all`/`--mirror`/`--tags` wholesale push is denied", () => {
  test("`git push --all origin` from a feature branch is DENIED (pushes main too)", () => {
    const v = decideBranchOnly("git push --all origin", undefined, "feature/x")
    expect(denied(v)).toBe(true)
    if (!v.allowed) expect(v.reason).toMatch(/all|mirror|tags|wholesale/i)
  })

  test("`git push --mirror origin` is DENIED (mirrors every ref)", () => {
    expect(denied(decideBranchOnly("git push --mirror origin", undefined, "feature/x"))).toBe(true)
  })

  test("`git push --tags origin` is DENIED", () => {
    expect(denied(decideBranchOnly("git push --tags origin", undefined, "feature/x"))).toBe(true)
  })

  test("NO over-correction: an explicit single feature-branch push is still ALLOWED", () => {
    const v = decideBranchOnly("git push origin feature/x:feature/x", undefined, "feature/x")
    expect(v.allowed).toBe(true)
  })
})

describe("HELLGATE: branch-only — bare destructive reset on a protected branch rewrites its history", () => {
  test("`git reset --hard HEAD~1` while ON main is DENIED (no explicit ref, still rewrites main)", () => {
    const v = decideBranchOnly("git reset --hard HEAD~1", undefined, "main")
    expect(denied(v)).toBe(true)
    if (!v.allowed) expect(v.reason).toMatch(/destructive|protected/i)
  })

  test("bare `git reset --hard` while ON master is DENIED", () => {
    expect(denied(decideBranchOnly("git reset --hard", undefined, "master"))).toBe(true)
  })

  test("`git reset --merge` and `--keep` on a protected branch are also denied", () => {
    expect(denied(decideBranchOnly("git reset --merge HEAD~2", undefined, "develop"))).toBe(true)
    expect(denied(decideBranchOnly("git reset --keep HEAD~1", undefined, "production"))).toBe(true)
  })

  test("NO over-correction: a destructive reset on a FEATURE branch is ALLOWED", () => {
    const v = decideBranchOnly("git reset --hard HEAD~1", undefined, "feature/x")
    expect(v.allowed).toBe(true)
  })

  test("NO over-correction: a NON-destructive (soft) reset on main is ALLOWED", () => {
    // `--soft` keeps the working tree + index; it does not discard committed
    // history the way `--hard` does, so branch-only does not block it.
    const v = decideBranchOnly("git reset --soft HEAD~1", undefined, "main")
    expect(v.allowed).toBe(true)
  })
})
