/**
 * `git_conflict_inspect` — surface the pure conflict parser
 * (`./conflict-parser`) as a typed first-class git tool so the
 * fix-merge-conflicts skill (and any future loop consumer) can list structured
 * merge conflicts in working-tree files without each caller hand-rolling a
 * marker scan.
 *
 * Two input modes:
 *   - explicit `paths` (REPO-RELATIVE; rejects absolute paths and `..`
 *     traversal at parse time — the runner is never invoked for a bad input).
 *   - auto-discover via `git status --porcelain=v1` filtering rows whose X or
 *     Y status char is `U` (the unmerged states: UU/AA/DD/AU/UA/DU/UD).
 *
 * READ-ONLY, CONCURRENCY-SAFE: the only spawn is `git status --porcelain=v1`
 * (no mutation, no `git merge`). Per-file `Bun.file(...).text()` reads are the
 * only filesystem touches and are confined to `ctx.cwd`.
 *
 * SECURITY POSTURE:
 *   - Explicit `paths` are STRICTLY validated (absolute or `..`-bearing →
 *     ok:false BEFORE the runner is called).
 *   - All file reads go through `path.join(ctx.cwd, file)` so a malicious
 *     porcelain row cannot escape the workspace (porcelain v1 paths are always
 *     repo-relative and POSIX-separated, but we treat all inputs as untrusted).
 */

import path from "node:path"
import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { safeRun, stderrReason } from "./_shared"
import { type ConflictParseResult, parseConflicts } from "./conflict-parser"
import type { GitRunner } from "./types"

// ─────────────────────────────────────────────────────────────────────────────
// Schema & constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_FILES = 50
const MAX_OUTPUT = 50_000

export const gitConflictInspectInputSchema = z.object({
  /** Explicit set of files to inspect. REPO-RELATIVE POSIX paths only —
   *  absolute paths and any segment equal to `..` are rejected at runtime. */
  paths: z.array(z.string()).optional().describe("Repo-relative paths to inspect"),
  /** Cap on inspected file count. Default 50. */
  maxFiles: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of files to inspect (default 50)"),
})
export type GitConflictInspectInput = z.infer<typeof gitConflictInspectInputSchema>

const truncate = (s: string): string => {
  if (s.length <= MAX_OUTPUT) return s
  return `${s.slice(0, MAX_OUTPUT)}\n… (truncated, ${s.length - MAX_OUTPUT} more chars)`
}

// ─────────────────────────────────────────────────────────────────────────────
// Path validation
// ─────────────────────────────────────────────────────────────────────────────

interface PathValidation {
  readonly ok: boolean
  readonly reason?: string
}

/** Reject absolute paths and any path with a `..` segment. POSIX-only
 *  separator check is intentional — porcelain v1 always emits `/`. */
const validatePath = (p: string): PathValidation => {
  if (p.length === 0) return { ok: false, reason: "empty path" }
  if (path.isAbsolute(p)) return { ok: false, reason: `absolute path rejected: ${p}` }
  const segs = p.split("/")
  if (segs.includes("..")) return { ok: false, reason: `path traversal rejected: ${p}` }
  return { ok: true }
}

interface PathSetValidation {
  readonly ok: boolean
  readonly reason?: string
}

const validatePaths = (paths: ReadonlyArray<string>): PathSetValidation => {
  for (const p of paths) {
    const v = validatePath(p)
    if (!v.ok) return { ok: false, reason: v.reason ?? "invalid path" }
  }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Porcelain v1 → conflict-file list
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract conflict-state files from `git status --porcelain=v1` output.
 *
 * Porcelain v1 row format:
 *   `XY <path>`   (X = index, Y = worktree). Conflict states are any entry
 *   whose X OR Y is `U`: `UU`/`AA`/`DD`/`AU`/`UA`/`DU`/`UD` (per `git status`
 *   man page §"Short Format").
 */
const parseConflictPaths = (stdout: string): string[] => {
  const out: string[] = []
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue
    const x = line.charAt(0)
    const y = line.charAt(1)
    if (x !== "U" && y !== "U") continue
    // Layout: "XY <path>" — char 2 is a space. Strip and any surrounding
    // whitespace from the path. Quoted paths (porcelain v1 with non-ASCII
    // C-escape quoting) appear within `"..."` — we strip the quotes but DO
    // NOT C-unescape (the conflict-parser doesn't care about exotic names
    // and our caller's expectations match the unquoted form).
    let p = line.slice(3)
    if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
      p = p.slice(1, -1)
    }
    if (p.length > 0) out.push(p)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-file inspection + rendering
// ─────────────────────────────────────────────────────────────────────────────

interface PerFileResult {
  readonly file: string
  readonly parse?: ConflictParseResult
  /** Non-null when the file could not be read (missing on disk, EACCES, …). */
  readonly readError?: string
}

const readAndParse = async (cwd: string, file: string): Promise<PerFileResult> => {
  try {
    const text = await Bun.file(path.join(cwd, file)).text()
    return { file, parse: parseConflicts(text) }
  } catch (e) {
    return { file, readError: errMessage(e) }
  }
}

/** Per-block one-line summary. */
const renderBlockLine = (
  b: {
    style: "two-way" | "three-way" | "diff3"
    startLine: number
    endLine: number
    oursLabel: string
    theirsLabel: string
    baseLabel?: string
  },
  idx: number,
): string => {
  const labels =
    b.style === "two-way"
      ? `(ours=${b.oursLabel || "?"}, theirs=${b.theirsLabel || "?"})`
      : `(ours=${b.oursLabel || "?"}, base=${b.baseLabel ?? "?"}, theirs=${b.theirsLabel || "?"})`
  const lineRange = `lines ${b.startLine}-${b.endLine}`
  const styleLabel = b.style.padEnd(9)
  return `  block ${idx + 1}: ${styleLabel} ${lineRange}  ${labels}`
}

const renderPerFile = (per: PerFileResult): string => {
  if (per.readError) {
    return `${per.file}: read error — ${per.readError}`
  }
  const parse = per.parse
  if (!parse) return `${per.file}: (no result)`
  const lines: string[] = []
  lines.push(`${per.file}: ${parse.blocks.length} conflict block(s)`)
  for (let i = 0; i < parse.blocks.length; i += 1) {
    const b = parse.blocks[i]
    if (b === undefined) continue
    lines.push(renderBlockLine(b, i))
  }
  if (parse.diagnostics.length === 0) {
    lines.push("  diagnostics: 0")
  } else {
    const head = `  diagnostics: ${parse.diagnostics.length}`
    const detail = parse.diagnostics.map((d) => `line ${d.line}: ${d.kind}`).join("; ")
    lines.push(`${head} — ${detail}`)
  }
  return lines.join("\n")
}

const formatOverall = (
  results: ReadonlyArray<PerFileResult>,
  totalFiles: number,
  capMessage: string | null,
): string => {
  const head: string[] = []
  if (capMessage) head.push(capMessage)
  else head.push(`${totalFiles} file(s) with conflicts:`)
  const body = results.map(renderPerFile).join("\n\n")
  return head.concat(["", body]).join("\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool
// ─────────────────────────────────────────────────────────────────────────────

interface DiscoverOutcome {
  readonly ok: boolean
  readonly paths?: string[]
  readonly errorOutput?: string
}

const discoverPaths = async (runner: GitRunner, ctx: ToolContext): Promise<DiscoverOutcome> => {
  const out = await safeRun(runner, ["status", "--porcelain=v1"], ctx.cwd, "git status", ctx.signal)
  if (out.kind === "spawn-error") return { ok: false, errorOutput: out.message }
  const r = out.result
  if (r.exitCode !== 0) {
    return { ok: false, errorOutput: stderrReason(r.stderr, r.exitCode, "git status") }
  }
  return { ok: true, paths: parseConflictPaths(r.stdout) }
}

/** Resolution of the path source — discriminated so the execute loop can branch
 *  cleanly without re-doing the discover-or-validate decision. */
type PathResolution =
  | { readonly kind: "ok"; readonly paths: ReadonlyArray<string>; readonly progress?: string }
  | { readonly kind: "err"; readonly output: string }

const resolvePaths = async (
  inputPaths: ReadonlyArray<string> | undefined,
  runner: GitRunner,
  ctx: ToolContext,
): Promise<PathResolution> => {
  if (inputPaths !== undefined) {
    const v = validatePaths(inputPaths)
    if (!v.ok) return { kind: "err", output: v.reason ?? "invalid paths" }
    return { kind: "ok", paths: inputPaths }
  }
  const disc = await discoverPaths(runner, ctx)
  if (!disc.ok) return { kind: "err", output: disc.errorOutput ?? "discover failed" }
  return { kind: "ok", paths: disc.paths ?? [], progress: "git status --porcelain=v1" }
}

interface CapPlan {
  readonly toRead: ReadonlyArray<string>
  readonly capMessage: string | null
}

const planRead = (candidatePaths: ReadonlyArray<string>, cap: number): CapPlan => {
  if (candidatePaths.length <= cap) return { toRead: candidatePaths, capMessage: null }
  return {
    toRead: candidatePaths.slice(0, cap),
    capMessage: `Found ${candidatePaths.length} conflicts; inspecting first ${cap} (raise maxFiles to see more)`,
  }
}

export const gitConflictInspectTool = (runner: GitRunner): Tool<GitConflictInspectInput> => ({
  name: "git_conflict_inspect",
  description:
    "List structured merge conflicts in working tree files (parses markers; never executes git merge)",
  inputSchema: gitConflictInspectInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: GitConflictInspectInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = gitConflictInspectInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    const { paths: inputPaths, maxFiles } = parsed.data
    const cap = maxFiles ?? DEFAULT_MAX_FILES

    if (inputPaths === undefined) {
      yield { type: "progress", message: "git status --porcelain=v1" }
    }
    const resolved = await resolvePaths(inputPaths, runner, ctx)
    if (resolved.kind === "err") {
      yield { type: "result", result: { ok: false, output: resolved.output } }
      return
    }

    const candidatePaths = resolved.paths
    if (candidatePaths.length === 0) {
      yield { type: "result", result: { ok: true, output: "(no conflicts)" } }
      return
    }

    const plan = planRead(candidatePaths, cap)
    yield { type: "progress", message: `inspecting ${plan.toRead.length} file(s)` }
    const results: PerFileResult[] = []
    for (const p of plan.toRead) {
      results.push(await readAndParse(ctx.cwd, p))
    }

    const out = formatOverall(results, candidatePaths.length, plan.capMessage)
    yield { type: "result", result: { ok: true, output: truncate(out) } }
  },
})
