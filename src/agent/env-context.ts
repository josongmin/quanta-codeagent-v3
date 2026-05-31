/**
 * ADR-0397 — Env / build dynamic context block.
 *
 * Adds an optional `## Environment` block to the per-turn `<system-reminder>`
 * that carries four orthogonal pieces of host / build context the model can
 * use to tune its tool choice and output:
 *
 *   - Platform: `platform arch release` (e.g. "darwin arm64 24.6.0")
 *   - Shell:    `$SHELL` literal (e.g. "/bin/zsh")
 *   - Git:      compressed porcelain-v2 summary (e.g. "M 5, ?? 2, ahead 3")
 *   - Package manager: bun / npm / pnpm / yarn (from lock-file presence)
 *
 * Design contract (load-bearing):
 *
 *   1. DEFAULT-OFF. `TurnContextInput.env` absent ⇒ buildDynamicContext emits
 *      ZERO new bytes — the rendered reminder is BYTE-IDENTICAL to the
 *      pre-ADR-0397 path. The byte-identical hellgate pins this. Empty object
 *      `{}` is treated as absent (no field set ⇒ no block).
 *
 *   2. REPLAY DETERMINISTIC. When `env` IS provided, the renderer is a pure
 *      function of the input — no `os.*`, no `process.*`, no `Date.now()`,
 *      no `spawnSync`. The live probe lives in {@link probeTurnEnv}, which
 *      the caller invokes explicitly (clock-injection pattern mirror).
 *
 *   3. CROSS-SLICE SAFE. The git-status compressor reuses
 *      `parsePorcelainV2` from `@/tool/git/status` (already an established
 *      cross-slice import from `@/agent/turn-diff` and
 *      `@/agent/git-observability`). No new slice boundaries crossed.
 *
 *   4. NO HEURISTICS. The pkg-manager inference is a fixed lookup over a
 *      closed set of well-known lock filenames; no fuzzy detection, no
 *      probabilistic ranking, no "best guess". `package.json` MUST be present
 *      for a result — the package.json gate is the existence signal that the
 *      directory is a JS/TS project at all.
 */

import { existsSync } from "node:fs"
import { arch, platform, release } from "node:os"
import { join } from "node:path"
import { parsePorcelainV2 } from "@/tool/git/status"

/**
 * Per-turn env / build context. All fields optional — each rendered as ONE
 * line only when present. When ALL fields are absent the renderer returns
 * `undefined` (no block, byte-identical default-OFF).
 *
 * The intent is "any of these may legitimately be unknown at the call site"
 * — e.g. a non-repo workspace has no `gitStatus`; a non-JS workspace has no
 * `pkgMgr`. Callers that probe live ({@link probeTurnEnv}) get the partially
 * populated shape automatically; callers that want a fully deterministic
 * replay supply the fields verbatim.
 */
export interface TurnEnvContext {
  /** Platform line — convention is `platform arch release`. Free-form
   *  string; the renderer prints it verbatim after the `Platform: ` prefix. */
  platform?: string
  /** Login shell literal (typically `$SHELL`). */
  shell?: string
  /** Compressed git status line (e.g. `M 5, ?? 2, ahead 3`). */
  gitStatus?: string
  /** Package manager id — one of `bun` / `npm` / `pnpm` / `yarn`. Free-form
   *  string from the renderer's perspective; the probe constrains it to the
   *  closed set. */
  pkgMgr?: string
}

const isEnvEmpty = (env: TurnEnvContext): boolean =>
  env.platform === undefined &&
  env.shell === undefined &&
  env.gitStatus === undefined &&
  env.pkgMgr === undefined

/**
 * Render the `## Environment` block, or `undefined` when the env carries no
 * fields. Lines are emitted in a stable order so the rendered text is
 * deterministic.
 */
export const renderEnvBlock = (env: TurnEnvContext | undefined): string | undefined => {
  if (env === undefined) return undefined
  if (isEnvEmpty(env)) return undefined
  const lines: string[] = ["## Environment"]
  if (env.platform !== undefined) lines.push(`Platform: ${env.platform}`)
  if (env.shell !== undefined) lines.push(`Shell: ${env.shell}`)
  if (env.gitStatus !== undefined) lines.push(`Git: ${env.gitStatus}`)
  if (env.pkgMgr !== undefined) lines.push(`Package manager: ${env.pkgMgr}`)
  return lines.join("\n")
}

// ─── probeTurnEnv ────────────────────────────────────────────────────────────

/**
 * Closed input shape for the live probe. `gitPorcelainStdout` is the
 * load-bearing injection seam: callers that already ran
 * `git status --porcelain=v2 --branch` (e.g. via the existing GitRunner port)
 * pipe the stdout in and we parse it deterministically. We deliberately do
 * NOT spawn git here — that would (a) inject async into a sync codepath the
 * prompt assembly depends on, and (b) duplicate the GitRunner port's error
 * handling. When `gitPorcelainStdout` is `undefined`, the gitStatus field is
 * simply omitted from the result (best-effort contract).
 */
export interface ProbeTurnEnvOpts {
  cwd: string
  /** Process environment to read SHELL from. Supplied by the composition root
   *  (runner / CLI bootstrap) — this slice never reads `process.env` itself
   *  (slice-boundary invariant). When omitted, the probe is hermetic: it reads
   *  from an empty record, so the SHELL field is simply absent (NOT a fallback
   *  to the ambient `process.env`). */
  processEnv?: Record<string, string | undefined>
  /** Pre-captured stdout of `git status --porcelain=v2 --branch`. When
   *  absent or empty, the gitStatus field is omitted. */
  gitPorcelainStdout?: string
}

const LOCK_FILE_TO_PKG: ReadonlyArray<readonly [filename: string, pkgMgr: string]> = [
  // Order matters: bun first because some bun projects also keep a vestigial
  // npm lock around during migration; the lock-file priority encodes which
  // manager is authoritative for the build.
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
]

const inferPkgMgr = (cwd: string): string | undefined => {
  // Gate on package.json — without it, lock-file presence is meaningless
  // (a stray lock in a non-JS directory should not produce a result).
  if (!existsSync(join(cwd, "package.json"))) return undefined
  for (const [filename, pkgMgr] of LOCK_FILE_TO_PKG) {
    if (existsSync(join(cwd, filename))) return pkgMgr
  }
  return undefined
}

/** Roll a porcelain v2 XY code into a single-letter bucket. Closed set,
 *  ordered so the FIRST matching condition wins (untracked / ignored / merge
 *  conflict precede edit-shape matches). Returns `"?"` for genuinely unknown
 *  codes — those never reach the bucket tally because parsePorcelainV2
 *  filters non-matching lines out earlier. */
const bucketForCode = (code: string): string => {
  if (code === "??") return "??"
  if (code === "!!") return "!!"
  if (code.includes("U")) return "U"
  if (code.includes("R") || code.includes("C")) return "R"
  if (code.includes("D")) return "D"
  if (code.includes("A")) return "A"
  if (code.includes("M") || code.includes("T")) return "M"
  return "?"
}

const BUCKET_ORDER = ["M", "A", "D", "R", "U", "??", "!!"] as const

const aheadBehindClause = (ahead: number, behind: number): string | undefined => {
  if (ahead === 0 && behind === 0) return undefined
  const segs: string[] = []
  if (ahead > 0) segs.push(`ahead ${ahead}`)
  if (behind > 0) segs.push(`behind ${behind}`)
  return segs.join(", ")
}

const compressGitStatus = (stdout: string): string | undefined => {
  // Empty stdout = "no probe ran" — caller didn't supply or the spawn
  // failed. Either way we omit the field.
  if (stdout.length === 0) return undefined
  const parsed = parsePorcelainV2(stdout)
  const counts: Record<string, number> = {}
  for (const f of parsed.files) {
    const bucket = bucketForCode(f.code.trim())
    counts[bucket] = (counts[bucket] ?? 0) + 1
  }
  const parts: string[] = []
  for (const k of BUCKET_ORDER) {
    const n = counts[k]
    if (n !== undefined && n > 0) parts.push(`${k} ${n}`)
  }
  const ab = aheadBehindClause(parsed.ahead, parsed.behind)
  if (ab !== undefined) parts.push(ab)
  // If a clean tree somehow slipped through (no files AND no ahead/behind)
  // we omit the field — there is genuinely nothing to report.
  if (parts.length === 0) return undefined
  return parts.join(", ")
}

/**
 * Live env probe. Pure of side effects beyond `node:os` + `node:fs` existence
 * checks. NEVER throws — every probe is best-effort and collapses to "field
 * omitted" on any unexpected failure.
 *
 * The probe is OPT-IN: the prompt assembly does NOT call this. A caller
 * (e.g. the runner / CLI bootstrap) invokes it once per turn and threads
 * the result into `TurnContextInput.env`.
 */
export const probeTurnEnv = (opts: ProbeTurnEnvOpts): TurnEnvContext => {
  const out: TurnEnvContext = {}
  // Platform — node:os primitives never throw under any normal condition.
  try {
    out.platform = `${platform()} ${arch()} ${release()}`
  } catch {
    // Defensive: leave field absent.
  }
  // Shell — only when an actual literal is present in the provided env.
  // Absent `processEnv` ⇒ hermetic empty record (never the ambient
  // `process.env`, which this slice must not read).
  const sourceEnv = opts.processEnv ?? {}
  const shellRaw = sourceEnv.SHELL
  if (typeof shellRaw === "string" && shellRaw.length > 0) out.shell = shellRaw
  // Git status — only when stdout was supplied.
  if (opts.gitPorcelainStdout !== undefined) {
    const compressed = compressGitStatus(opts.gitPorcelainStdout)
    if (compressed !== undefined) out.gitStatus = compressed
  }
  // Package manager — fs existsSync, best-effort.
  try {
    const pm = inferPkgMgr(opts.cwd)
    if (pm !== undefined) out.pkgMgr = pm
  } catch {
    // Defensive: leave field absent.
  }
  return out
}
