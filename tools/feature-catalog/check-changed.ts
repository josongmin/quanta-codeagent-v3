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
  // `tools/dev/` USED to be exempt here, on the stated grounds that "none of it has
  // ever been catalogued (0 of ~20 files appear in any evidence.code), so requiring
  // an fc entry for the NEXT one only makes that one arbitrary".
  //
  // That premise is measurably false, and became false while the exemption sat here.
  // Measured at this commit: 102 tracked `tools/dev/*.ts`, and **51 of them ARE
  // referenced** by `evidence.code` — an exact half, most of it enrolled by the
  // sep-9/sep-12 verification campaigns. The coverage the exemption was meant to
  // keep principled had become a coin flip, and the ONE thing the gate exists to
  // stop — a new harness file landing uncatalogued — was the thing it allowed.
  //
  // Removed rather than re-justified. The asymmetry already in this function does the
  // rest: an ADDED file blocks, a MODIFIED one is informational. So the 51 that are
  // not yet catalogued stay quiet until someone deliberately enrolls them, and the
  // next NEW harness file has to say what it is. No bulk-enrolment churn.
  //
  // Deliberately still NOT `^tools\//` for the rest: tools/pm, tools/god-code and
  // tools/arch-gen ARE catalogued features (they encode product policy).
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

/**
 * Parse `git ls-files --others --exclude-standard` — one path per line, no
 * status column. Every such path is a file git has never seen, so it is an
 * ADDED file for this gate's purposes.
 *
 * Splitting on newline (not whitespace) is load-bearing: a path may contain
 * spaces, and a truncated path silently stops matching fc evidence, which would
 * turn a real block into a phantom one.
 */
export function parseUntrackedFiles(stdout: string): DiffFile[] {
  const out: DiffFile[] = []
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue
    out.push({ path: line, status: "A" })
  }
  return out
}

/**
 * Union several diff sources into one list, at most one record per path.
 *
 * `A` OUTRANKS every other status: a file that this branch introduced and then
 * modified again in the working tree is still a NEW file, and demoting it to
 * `M` would move it from the blocking list to the advisory one — the precise
 * downgrade this gate exists to prevent. Order of arguments therefore cannot
 * change the verdict.
 *
 * First-seen order is preserved so operator output stays stable run to run.
 */
export function mergeDiffSources(...sources: ReadonlyArray<readonly DiffFile[]>): DiffFile[] {
  const byPath = new Map<string, DiffFile>()
  for (const source of sources) {
    for (const file of source) {
      const existing = byPath.get(file.path)
      if (existing === undefined) {
        byPath.set(file.path, file)
        continue
      }
      if (existing.status !== "A" && file.status === "A") byPath.set(file.path, file)
    }
  }
  return [...byPath.values()]
}
