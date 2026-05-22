/**
 * Git-write-protection static deny (ADR-0086).
 *
 * Absorbed from Cursor's `cursorsandbox` Seatbelt SBPL deny-regex (verbatim
 * verified — see docs/analysis/code-agent-loop/cursor-rust-engine.md §3.2 and
 * docs/analysis/code-agent-suit/cursor-repomap.md L127): cursorsandbox denies
 * *write* to `.git/hooks`, `.git/config`, `.vscode`, `.cursorignore`, and
 * `*.code-workspace`. Those are not data files — a write to any of them is a
 * code-execution / policy-escape vector.
 *
 * THREAT MODEL — why a WRITE to these paths is an escape vector:
 *   - `.git/hooks/**` — git executes these scripts automatically on the next
 *     git operation (`pre-commit`, `post-checkout`, `pre-push`, …). An agent
 *     that can write `.git/hooks/pre-commit` has achieved arbitrary code
 *     execution on the host the instant any later git command runs — even one
 *     issued by the *user*, outside the agent's own sandbox. This is the
 *     canonical sandbox-escape.
 *   - `.git/config` — `core.hooksPath`, `core.fsmonitor`, `core.pager`,
 *     `core.editor`, `[alias]` and `[filter "…"].clean/.smudge` all name
 *     executables that git will run. Writing config relocates/installs hooks
 *     and command shims, an indirect path to the same code execution.
 *   - `.git/hooks` (the directory itself) — creating/replacing the directory
 *     (e.g. via symlink) is equivalent to controlling its contents.
 *   - `.vscode/**` — `tasks.json` / `launch.json` carry shell command lines an
 *     editor auto-runs; `settings.json` can repoint tool binaries. Same class
 *     of editor-driven execution. (`editor_config`.)
 *
 * This module is PURE and ADDITIVE. It is a path-pattern DETECTOR only — it
 * performs NO I/O, holds NO state, and is called by NOBODY in this commit.
 * Default-OFF / byte-identical: absent a caller wiring `gitWriteProtectReason`
 * into the dispatch seam / permission gate, no existing path changes. A future
 * caller opts in by statically denying a write whose target returns a non-null
 * reason. (Dispatch-seam / permission-gate wiring is a documented follow-up;
 * see ADR-0086.)
 *
 * Conventions mirror `src/permission/review-kind.ts`: closed union via
 * union-of-literals + an `ALL_*` runtime array, exhaustive `switch` with a
 * `never` default, no sentinels / no silent normalization, no `any`.
 *
 * PRECISION — what counts as a match. Matching is done on PATH SEGMENTS, never
 * on raw substrings. The path is split on both `/` and `\` (platform
 * separators) and a leading `./` is dropped; trailing slashes are tolerated.
 * A pattern matches only when whole segments line up. Consequences:
 *   - `.gitignore`            → null (segment is `.gitignore`, not `.git`).
 *   - `git/config`            → null (segment is `git`, not `.git`).
 *   - `mygit/config`          → null.
 *   - `src/config`            → null.
 *   - `.github/workflows/x`   → null (segment is `.github`, not `.git`).
 *   - `notes/.git-stuff`      → null.
 *   - `foo/.git/hooks/pre-commit` → git_hooks (nested .git: submodule/worktree).
 */

/**
 * Why a write to the matched path is a security escape vector. Closed union —
 * adding a member requires an ADR amendment and updates to every exhaustive
 * switch over this type.
 *
 *  - `git_hooks`     — a file UNDER `.git/hooks/` (e.g. `.git/hooks/pre-commit`).
 *                      Git auto-executes it on the next matching git op.
 *  - `git_hooks_dir` — the `.git/hooks` directory entry itself (no trailing
 *                      path component). Controlling the dir == controlling its
 *                      hooks (symlink/replace).
 *  - `git_config`    — the `.git/config` file. Names executables git will run
 *                      (`core.hooksPath`, `[filter].clean`, aliases, …).
 *  - `editor_config` — a file UNDER `.vscode/` (`tasks.json` / `launch.json` /
 *                      `settings.json`). Editor-driven command execution.
 */
export type GitWriteProtectReason = "git_hooks" | "git_hooks_dir" | "git_config" | "editor_config"

/** All protect reasons enumerated — used by callers/tests for exhaustive
 *  coverage assertions without `as const` gymnastics. */
export const ALL_GIT_WRITE_PROTECT_REASONS: ReadonlyArray<GitWriteProtectReason> = [
  "git_hooks",
  "git_hooks_dir",
  "git_config",
  "editor_config",
]

/**
 * Normalize a path into its non-empty segments.
 *
 * Splits on BOTH `/` and `\` so a Windows-style `foo\.git\config` is matched
 * identically to a POSIX `foo/.git/config`. Empty segments (from a leading
 * separator, a trailing slash, or a `//`) and bare `.` segments are dropped so
 * that trailing slashes and `./` prefixes do not perturb segment alignment.
 * Pure — no I/O, no normalization of `..` (a `..` segment is preserved as-is;
 * it can never equal a literal pattern segment so it cannot cause a match).
 */
const segmentsOf = (path: string): ReadonlyArray<string> =>
  path.split(/[/\\]+/).filter((seg) => seg.length > 0 && seg !== ".")

/**
 * Index of the FIRST `.git` segment, or -1 if none. A nested `.git` (git
 * submodule or linked worktree, e.g. `vendor/lib/.git/hooks/pre-commit`) is
 * matched by scanning every segment, not just the first.
 */
const firstGitDirIndex = (segments: ReadonlyArray<string>): number =>
  segments.findIndex((seg) => seg === ".git")

/**
 * Classify why writing `path` would be a security escape vector, or `null` if
 * the path is not protected. PURE path-pattern matcher — no filesystem access.
 *
 * Accepts a relative OR absolute path, POSIX or Windows separators, with or
 * without a trailing slash or a leading `./`. Matching is segment-anchored
 * (see module doc): substrings like `.gitignore`, `git/config`, `src/config`
 * or `.github/…` never match.
 *
 * Resolution order (a path can structurally satisfy only one):
 *   1. `.git/hooks/<something>`            → `git_hooks`
 *   2. `.git/hooks` (terminal dir entry)   → `git_hooks_dir`
 *   3. `.git/config`                       → `git_config`
 *   4. `.vscode/<something>`               → `editor_config`
 */
export const gitWriteProtectReason = (relativeOrAbsPath: string): GitWriteProtectReason | null => {
  const segments = segmentsOf(relativeOrAbsPath)

  const gitIdx = firstGitDirIndex(segments)
  if (gitIdx !== -1) {
    const afterGit = segments[gitIdx + 1]
    if (afterGit === "hooks") {
      // `.git/hooks` with a further component is a hook file; bare is the dir.
      return segments.length > gitIdx + 2 ? "git_hooks" : "git_hooks_dir"
    }
    if (afterGit === "config" && segments.length === gitIdx + 2) {
      // `.git/config` exactly — not `.git/config/x` (no such git layout) and
      // not `.git/configfoo`.
      return "git_config"
    }
  }

  const vscodeIdx = segments.findIndex((seg) => seg === ".vscode")
  if (vscodeIdx !== -1 && segments.length > vscodeIdx + 1) {
    // A file UNDER `.vscode/`. A bare `.vscode` directory write is not flagged
    // (creating the empty dir alone has no execution effect).
    return "editor_config"
  }

  return null
}

/** Convenience predicate: does writing `path` hit a protected escape vector? */
export const isGitWriteProtected = (path: string): boolean => gitWriteProtectReason(path) !== null
