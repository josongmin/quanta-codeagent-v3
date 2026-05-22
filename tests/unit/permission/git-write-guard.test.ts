/**
 * Git-write-protection static-deny coverage (ADR-0086).
 *
 * Covers:
 *   - ALL_GIT_WRITE_PROTECT_REASONS completeness (closed-union enumeration).
 *   - Each protected pattern HITS its expected reason (.git/hooks/*, the
 *     .git/hooks dir, .git/config, .vscode/*), POSIX + Windows separators,
 *     trailing slashes, leading ./, absolute paths, nested .git (submodule).
 *   - Near-misses do NOT match (.gitignore, git/config, src/config, .github/,
 *     notes/.git-stuff, .git/configfoo, mygit/config, bare .vscode dir).
 *   - isGitWriteProtected agrees with gitWriteProtectReason.
 *   - Exhaustive switch over GitWriteProtectReason with a `never` default
 *     compiles (compile-time) and runs (asserted at runtime).
 *
 * No mocks, no fixtures, no I/O — git-write-guard.ts is a pure path matcher.
 */
import { describe, expect, test } from "bun:test"
import {
  ALL_GIT_WRITE_PROTECT_REASONS,
  type GitWriteProtectReason,
  gitWriteProtectReason,
  isGitWriteProtected,
} from "@/permission/git-write-guard"

describe("git-write-guard — enum completeness", () => {
  test("ALL_GIT_WRITE_PROTECT_REASONS enumerates exactly 4 unique literals", () => {
    expect(ALL_GIT_WRITE_PROTECT_REASONS.length).toBe(4)
    expect(new Set(ALL_GIT_WRITE_PROTECT_REASONS).size).toBe(4)
  })
})

describe("git-write-guard — protected patterns HIT", () => {
  const hits: ReadonlyArray<readonly [string, GitWriteProtectReason]> = [
    // .git/hooks/* → git_hooks
    [".git/hooks/pre-commit", "git_hooks"],
    [".git/hooks/post-checkout", "git_hooks"],
    [".git/hooks/pre-push", "git_hooks"],
    [".git/hooks/nested/deep", "git_hooks"],
    // .git/hooks (the dir) → git_hooks_dir
    [".git/hooks", "git_hooks_dir"],
    [".git/hooks/", "git_hooks_dir"],
    // .git/config → git_config
    [".git/config", "git_config"],
    [".git/config/", "git_config"],
    // .vscode/* → editor_config
    [".vscode/tasks.json", "editor_config"],
    [".vscode/launch.json", "editor_config"],
    [".vscode/settings.json", "editor_config"],
  ]

  test.each(
    hits.map(([p, r]) => [p, r] as const),
  )("gitWriteProtectReason(%j) === %s", (path, reason) => {
    expect(gitWriteProtectReason(path)).toBe(reason)
    expect(isGitWriteProtected(path)).toBe(true)
  })
})

describe("git-write-guard — path normalization (same target, many spellings)", () => {
  test("leading ./ is tolerated", () => {
    expect(gitWriteProtectReason("./.git/hooks/pre-commit")).toBe("git_hooks")
    expect(gitWriteProtectReason("./.git/config")).toBe("git_config")
  })

  test("absolute paths match (segments are anchored, not the leading slash)", () => {
    expect(gitWriteProtectReason("/Users/me/repo/.git/hooks/pre-commit")).toBe("git_hooks")
    expect(gitWriteProtectReason("/srv/proj/.git/config")).toBe("git_config")
    expect(gitWriteProtectReason("/home/dev/app/.vscode/tasks.json")).toBe("editor_config")
  })

  test("Windows-style backslash separators match identically", () => {
    expect(gitWriteProtectReason(".git\\hooks\\pre-commit")).toBe("git_hooks")
    expect(gitWriteProtectReason("foo\\.git\\config")).toBe("git_config")
    expect(gitWriteProtectReason("C:\\proj\\.vscode\\launch.json")).toBe("editor_config")
  })

  test("redundant separators do not perturb segment alignment", () => {
    expect(gitWriteProtectReason(".git//hooks//pre-commit")).toBe("git_hooks")
  })
})

describe("git-write-guard — nested .git (submodule / linked worktree)", () => {
  test("a .git deep in the tree is still matched", () => {
    expect(gitWriteProtectReason("vendor/lib/.git/hooks/pre-commit")).toBe("git_hooks")
    expect(gitWriteProtectReason("modules/sub/.git/config")).toBe("git_config")
    expect(gitWriteProtectReason("a/b/c/.git/hooks")).toBe("git_hooks_dir")
  })

  test("a .vscode deep in the tree is still matched", () => {
    expect(gitWriteProtectReason("packages/app/.vscode/settings.json")).toBe("editor_config")
  })
})

describe("git-write-guard — near-misses do NOT match", () => {
  const misses: ReadonlyArray<string> = [
    // substring-but-not-segment traps
    ".gitignore",
    ".gitattributes",
    "notes/.git-stuff",
    "notes/.git-stuff/hooks",
    "mygit/config",
    "git/config",
    "src/config",
    "config",
    // .github is a distinct segment, not .git
    ".github/workflows/ci.yml",
    ".github/dependabot.yml",
    // hooks/config outside a .git dir
    "hooks/pre-commit",
    "scripts/hooks/pre-commit",
    // .git present but not pointing at a protected entry
    ".git/index",
    ".git/HEAD",
    ".git/refs/heads/main",
    ".git/objects/ab/cdef",
    // .git/config with a trailing component is NOT the config file
    ".git/config/extra",
    // configfoo / hooksfoo are different segments
    ".git/configfoo",
    ".git/hooksfoo/x",
    // bare .vscode dir (no file under it) — creating empty dir has no exec effect
    ".vscode",
    ".vscode/",
    // .vscodefoo is a different segment
    ".vscodefoo/tasks.json",
    // empty / dotless
    "",
    ".",
    "./",
  ]

  test.each(misses.map((p) => [p] as const))("gitWriteProtectReason(%j) === null", (path) => {
    expect(gitWriteProtectReason(path)).toBeNull()
    expect(isGitWriteProtected(path)).toBe(false)
  })
})

describe("git-write-guard — exhaustive switch over reason compiles + runs", () => {
  // Local exhaustive switch that would fail to COMPILE if a member were added
  // to GitWriteProtectReason without a case here (mirror of the module's own
  // `never` discipline). Runtime assertion proves every arm is reachable.
  const label = (reason: GitWriteProtectReason): string => {
    switch (reason) {
      case "git_hooks":
      case "git_hooks_dir":
      case "git_config":
      case "editor_config":
        return reason
      default: {
        const _exhaustive: never = reason
        throw new Error(`Unhandled GitWriteProtectReason: ${String(_exhaustive)}`)
      }
    }
  }

  test("every reason in ALL_GIT_WRITE_PROTECT_REASONS is handled", () => {
    for (const reason of ALL_GIT_WRITE_PROTECT_REASONS) {
      expect(label(reason)).toBe(reason)
    }
  })

  test("the matcher only ever returns a member of the closed union (or null)", () => {
    const observed = new Set<GitWriteProtectReason>()
    const samples = [".git/hooks/pre-commit", ".git/hooks", ".git/config", ".vscode/tasks.json"]
    for (const s of samples) {
      const r = gitWriteProtectReason(s)
      if (r !== null) {
        expect(ALL_GIT_WRITE_PROTECT_REASONS).toContain(r)
        observed.add(r)
      }
    }
    expect(observed).toEqual(new Set(ALL_GIT_WRITE_PROTECT_REASONS))
  })
})
