/**
 * PR-time gate: if a PR adds a new .ts file under src/, that file MUST appear in
 * some fc YAML's `evidence.code`. Modified files only warn — they often
 * legitimately touch helpers that ride along with a parent feature.
 *
 * Pure decision logic lives here; the CLI handles `git diff` invocation.
 *
 * Why "added files must be in fc": the canonical drift source is *new code
 * landing without a fc entry*. Modifying existing leaves is fine. New
 * standalone files are where features hide.
 */
import type { LoadedFeature } from "./schema"

export interface DiffFile {
  readonly path: string
  readonly status: "A" | "M" | "D" | "R" | "C"
}

export interface CheckChangedResult {
  readonly ok: boolean
  /** Newly-added src files not yet in any fc evidence — these BLOCK. */
  readonly addedUntracked: readonly string[]
  /** Modified files not in any fc evidence — informational only, doesn't block. */
  readonly modifiedUntracked: readonly string[]
}

/** Files we never require to be in fc: tests, barrels, type-only modules,
 *  workspaces directory leftovers. */
const EXEMPT_PATTERNS: readonly RegExp[] = [
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /\.d\.ts$/,
  /\/index\.ts$/,
  /^tests\//,
  /^\.claude\/worktrees\//,
  /^scripts\//,
  /^docs\//,
  /^tools\/feature-catalog\//,
  // Dev-analysis tooling run via `bun tools/…` (not shipped product features) —
  // same category as scripts/. The trajectory timeline + viewer render recorded
  // bench cassettes for debugging; they are not user-facing surfaces.
  /^tools\/trajectory-timeline\.ts$/,
  /^tools\/trajectory-viewer\//,
]

/** True ⇒ this src file is exempt from the "must be in fc" rule. */
export function isExemptFromFc(path: string): boolean {
  if (!path.endsWith(".ts")) return true
  return EXEMPT_PATTERNS.some((re) => re.test(path))
}

export function runCheckChanged(
  diff: readonly DiffFile[],
  features: readonly LoadedFeature[],
): CheckChangedResult {
  const referenced = new Set<string>()
  for (const { feature } of features) {
    for (const p of feature.evidence.code) referenced.add(p)
  }

  const addedUntracked: string[] = []
  const modifiedUntracked: string[] = []
  for (const f of diff) {
    if (isExemptFromFc(f.path)) continue
    if (referenced.has(f.path)) continue
    if (f.status === "A") addedUntracked.push(f.path)
    else if (f.status === "M") modifiedUntracked.push(f.path)
  }

  return {
    ok: addedUntracked.length === 0,
    addedUntracked,
    modifiedUntracked,
  }
}

/** Parse `git diff --name-status` output into structured records. The output
 *  format is `<status>\t<path>` per line (rename is `R<n>\t<from>\t<to>`). */
export function parseDiffNameStatus(stdout: string): DiffFile[] {
  const out: DiffFile[] = []
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue
    const parts = line.split("\t")
    const code = parts[0]?.[0]
    if (code !== "A" && code !== "M" && code !== "D" && code !== "R" && code !== "C") continue
    // For renames/copies the destination is the second path field.
    const path = code === "R" || code === "C" ? parts[2] : parts[1]
    if (path === undefined) continue
    out.push({ path, status: code })
  }
  return out
}
