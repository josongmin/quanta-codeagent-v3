/**
 * Workspace isolation for speculative branch search (ADR-0084).
 *
 * Each candidate runs against a private workspace so concurrent edits never
 * collide. Two strategies, both implementing the `Isolator` port:
 *
 *   - `tmpdirIsolator`  : `mkdtemp` + `cp -r` of the source tree, EXCLUDING
 *                         `.git` and `node_modules`. Optionally symlinks the
 *                         parent `node_modules` so tsc/test resolve deps —
 *                         the symlink is removed FIRST on cleanup so the
 *                         `rm -rf` of the tmpdir can NEVER follow it into the
 *                         real `node_modules` ([[worktree-node-modules-hazard]]).
 *   - `worktreeIsolator`: `git worktree add` per candidate (fast on big repos,
 *                         shares object store). Same node_modules-symlink
 *                         safety. Requires a git repo.
 *
 * The hazard guard is the WHOLE point of this file — a naive `rm -rf` over a
 * dir that symlinks `node_modules` deletes the real dependency tree. Both
 * cleanups `unlink` the symlink (link only, never target) before removing the
 * workspace.
 */

import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runShell } from "@/runtime"
import type { Isolator } from "./types"

export interface TmpdirIsolatorOptions {
  /** Source tree copied into each candidate workspace. */
  srcDir: string
  /** When true, symlink `${srcDir}/node_modules` into the workspace so
   *  tsc/test resolve dependencies without a multi-GB copy. Default true. */
  linkNodeModules?: boolean
}

/** Remove a `node_modules` symlink (link ONLY) if present, then `rm -rf` the
 *  workspace. Splitting the unlink out is the hazard guard: `rmSync(recursive)`
 *  over a symlinked dir would otherwise delete the link TARGET's contents. */
const safeCleanup = (workspace: string): void => {
  const nm = join(workspace, "node_modules")
  try {
    // `unlinkSync` removes a symlink itself (never follows). If `node_modules`
    // is a real directory (copied, not linked) this throws EISDIR — caught,
    // and the subsequent rmSync handles it as normal content.
    if (existsSync(nm)) unlinkSync(nm)
  } catch {
    // not a symlink (real dir) — fall through to rmSync.
  }
  rmSync(workspace, { recursive: true, force: true })
}

export const tmpdirIsolator = (opts: TmpdirIsolatorOptions): Isolator => ({
  async acquire(i) {
    const workspace = mkdtempSync(join(tmpdir(), `branch-cand-${i}-`))
    // Copy the source tree minus the heavy/derived dirs. `cpSync` filter
    // returns false to SKIP an entry (and its subtree).
    cpSync(opts.srcDir, workspace, {
      recursive: true,
      filter: (src) => !src.includes("/node_modules") && !src.includes("/.git"),
    })
    if (opts.linkNodeModules !== false) {
      const srcNm = join(opts.srcDir, "node_modules")
      if (existsSync(srcNm)) {
        symlinkSync(srcNm, join(workspace, "node_modules"), "dir")
      }
    }
    return {
      workspace,
      cleanup: async () => {
        safeCleanup(workspace)
      },
    }
  },
})

export interface WorktreeIsolatorOptions {
  /** Repo root the worktrees branch from. Must be a git repo. */
  repoRoot: string
  /** Symlink parent node_modules into each worktree (default true). */
  linkNodeModules?: boolean
}

export const worktreeIsolator = (opts: WorktreeIsolatorOptions): Isolator => ({
  async acquire(i) {
    const slug = `branchsearch-${i}-${Date.now().toString(36)}`
    const branch = `branch-${slug}`
    const workspace = join(opts.repoRoot, ".claude", "worktrees", `agent-${slug}`)
    const add = await runShell(`git worktree add --no-track -B ${branch} "${workspace}" HEAD`, {
      cwd: opts.repoRoot,
    })
    if (add.exitCode !== 0) {
      throw new Error(
        `branch-search worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`,
      )
    }
    if (opts.linkNodeModules !== false) {
      const srcNm = join(opts.repoRoot, "node_modules")
      if (existsSync(srcNm)) symlinkSync(srcNm, join(workspace, "node_modules"), "dir")
    }
    return {
      workspace,
      cleanup: async () => {
        // Unlink the node_modules symlink BEFORE git removes the worktree dir
        // (git worktree remove --force does an rm -rf that would follow it).
        const nm = join(workspace, "node_modules")
        try {
          if (existsSync(nm)) unlinkSync(nm)
        } catch {
          // real dir — git remove will handle it.
        }
        await runShell(`git worktree remove --force "${workspace}"`, { cwd: opts.repoRoot })
        await runShell(`git branch -D ${branch}`, { cwd: opts.repoRoot })
      },
    }
  },
})
