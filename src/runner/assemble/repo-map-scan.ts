/**
 * Repo-map scan adapter (RFC jun-6 §4.3 / §4.4) — the side-effecting `scan`
 * the `probeRepoMap` probe injects.
 *
 * It does the ONE shell call (`rg --files`) the prompt-assembly slice must NOT
 * do, then reuses the `file_tree_summary` slice's already-shipped PURE helpers
 * (`aggregateFileTree` / `renderFileTree`) over that stdout, and applies the
 * `maxChars` hard backstop. This is the same "reuse the pure core, re-do the
 * I/O at the seam" pattern `env-context` uses with `parsePorcelainV2`: the
 * `@/agent` slice never spawns a shell — the shell call lives here in the runner.
 *
 * THREE independent caps fire (RFC §4.4), all deliberate:
 *   1. `maxFiles` — `aggregateFileTree` truncates at the file cap (`… (file
 *      cap … reached)` marker).
 *   2. `maxDepth` — deeper subtrees roll up into `…/ (+N deeper)` markers.
 *   3. `maxChars` — a SHAPE-INDEPENDENT backstop applied AFTER render: the
 *      rendered string is truncated on a line boundary and a fixed
 *      `… (repo map truncated …)` marker appended. This is the bound that
 *      guarantees turn-0 can never blow up regardless of repo shape.
 *
 * Determinism: `rank:"alpha"` (byte-sort) so NO recency git-log call is needed —
 * a map wants stable top-level layout, not recency ordering. Best-effort: any
 * shell failure / non-repo / empty dir ⇒ `undefined` (the probe then omits the
 * field, byte-identical to the no-map path).
 */

import { aggregateFileTree, renderFileTree } from "@/tool"

/** Run a command and capture its stdout/exit/timeout. Duck-typed so the runner
 *  injects `@/runtime`'s `runShell` and tests inject a canned stdout — this
 *  module never imports `@/runtime` directly (keeps it unit-testable + slice-
 *  portable). */
export type RepoMapShell = (
  cmd: string,
  opts: { cwd: string; signal?: AbortSignal },
) => Promise<{ stdout: string; exitCode: number; timedOut: boolean }>

/** Fixed truncation marker (a literal — keeps the adapter pure-of-clock). */
export const REPO_MAP_TRUNCATION_MARKER =
  "… (repo map truncated — call file_tree_summary for detail)"

/**
 * Truncate a rendered tree to at most `maxChars` characters on a LINE boundary,
 * appending {@link REPO_MAP_TRUNCATION_MARKER}. Pure. When the string already
 * fits, returns it unchanged. The marker itself is allowed to push the result a
 * few chars past `maxChars` — the cap bounds the TREE content, and the marker is
 * a fixed-length tail; what matters is that an unbounded repo cannot produce an
 * unbounded string.
 */
export const truncateRepoMap = (rendered: string, maxChars: number): string => {
  if (maxChars <= 0) return REPO_MAP_TRUNCATION_MARKER
  if (rendered.length <= maxChars) return rendered
  // Cut at the last newline at or before maxChars so we never split a line.
  const slice = rendered.slice(0, maxChars)
  const lastNl = slice.lastIndexOf("\n")
  const body = lastNl > 0 ? slice.slice(0, lastNl) : slice
  return `${body}\n${REPO_MAP_TRUNCATION_MARKER}`
}

/** Options for {@link makeRepoMapScan}. */
export interface MakeRepoMapScanOpts {
  /** Injected shell — the runner passes `@/runtime`'s `runShell`. */
  readonly shell: RepoMapShell
  /** Optional abort signal threaded into the scan. */
  readonly signal?: AbortSignal
}

/**
 * Build the `scan` adapter `probeRepoMap` consumes. The returned function does
 * the rg call, aggregate/render with `rank:"alpha"`, and the char backstop;
 * returns `undefined` on any failure or empty repo.
 */
export const makeRepoMapScan =
  (deps: MakeRepoMapScanOpts) =>
  async (opts: {
    cwd: string
    maxDepth: number
    maxFiles: number
    maxChars: number
  }): Promise<string | undefined> => {
    // `rg --files` lists every non-ignored file, one per line, relative to cwd.
    // No model-supplied path here — the map always scans the workspace root.
    const r = await deps.shell("rg --files --color=never", {
      cwd: opts.cwd,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    })
    // rg exit 1 = "no matches" (empty repo) — not an error; exit >1 / timeout is.
    if (r.exitCode > 1 || r.timedOut) return undefined
    const files = r.stdout
      .trimEnd()
      .split("\n")
      .filter((l) => l.length > 0)
    if (files.length === 0) return undefined
    // PURE core: cap-1 (maxFiles) + cap-2 (maxDepth) live in aggregate/render.
    const agg = aggregateFileTree(files, opts.maxDepth, opts.maxFiles)
    const rendered = renderFileTree(agg, opts.maxFiles, undefined, "alpha")
    if (rendered.length === 0 || rendered === "(no files)") return undefined
    // cap-3 (maxChars) — shape-independent backstop.
    return truncateRepoMap(rendered, opts.maxChars)
  }
