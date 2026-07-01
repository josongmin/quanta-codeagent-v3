/**
 * Repo source enumeration + strict-preset LSP grounding probe (pure code motion
 * from `driver.ts`, byte-identical). Owns the Agentless source-file walk
 * (`enumerateRepoSources` + its extension/dir/limit constants + dirent
 * classifier) and the strict-preset live-LSP grounding verification
 * (`verifyStrictPresetLspGrounding` + `StrictLspGroundingDegradedError` + the
 * dominant-language probe target resolver). A leaf: no driver orchestration
 * dependency.
 */

import { type Dirent, readdirSync } from "node:fs"
import { extname, join, relative, sep } from "node:path"
import { lspBinaryAvailable, lspExtensionToLanguage, proveStrictLspReady } from "@/agent"
import { presetRequiresLiveLspGrounding } from "@/runner/knobs"
import {
  byteCompare,
  isRealGroundingFailure,
  type LspGroundingReceipt,
  renderLspGroundingStatus,
} from "@/shared"
import type { BenchPosture } from "../knobs-bench"

/** Source file extensions enumerated for Agentless localization. The set
 *  matches Agentless paper §4 (Python is the SWE-bench corpus; we additionally
 *  include common companion languages for non-SWE-bench harnesses). Tests are
 *  excluded by directory walk (see `isExcludedDir`) — the grader supplies its
 *  own tests, so test-file localization is wasted budget. */
const SOURCE_EXTENSIONS = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".php",
])

/** Directories that NEVER contain source code we want the LLM to consider:
 *    - `test`/`tests`              — grader supplies its own; agent edits are
 *                                    discarded (see SWEBENCH_DIRECTIVE)
 *    - `node_modules`/`vendor`/etc — third-party
 *    - `.git`/`.venv`/`__pycache__`— infra noise
 *    - `dist`/`build`/`target`     — build artifacts */
const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  "test",
  "tests",
  "testing",
  "__tests__",
])

/** Hard cap on the file-tree walk — defensive against pathological repos.
 *  Above this we stop walking and return whatever we collected. */
const MAX_WALK_FILES = 5_000

/** Enumerate source-file relative paths under `repoRoot`. Excludes tests,
 *  build artifacts, and version-control infra. Pure-ish (does I/O via
 *  `readdirSync` only — that is the contract of the function, called inside
 *  `prepareIssueHint`'s fileTree dep). Returns an empty array on any thrown
 *  syscall (repo doesn't exist, permission denied, …); the caller falls back
 *  to regex extraction in that case. */
/** Classify one directory entry as either a child-dir-to-descend, a source-
 *  file relative path, or nothing-of-interest. Pure helper — splitting it
 *  out keeps `enumerateRepoSources` under biome's complexity ceiling. */
const classifyDirent = (
  e: Dirent,
  dir: string,
  repoRoot: string,
): { kind: "dir"; path: string } | { kind: "file"; rel: string } | undefined => {
  const name = e.name
  if (typeof name !== "string" || name.length === 0) return undefined
  const full = join(dir, name)
  if (e.isDirectory()) {
    if (EXCLUDED_DIRS.has(name)) return undefined
    // Hidden dirs (starting with ".") are infra (`.git`, `.cache`, …) — never
    // descend; SOURCE_EXTENSIONS doesn't gain anything from them.
    if (name.startsWith(".")) return undefined
    return { kind: "dir", path: full }
  }
  if (!e.isFile()) return undefined
  const dot = name.lastIndexOf(".")
  if (dot === -1) return undefined
  const ext = name.slice(dot)
  if (!SOURCE_EXTENSIONS.has(ext)) return undefined
  // Relative path — normalize separators to forward-slash so paths match what
  // the LLM sees in GitHub-style issue text.
  const rel = relative(repoRoot, full).split(sep).join("/")
  if (rel.length === 0) return undefined
  return { kind: "file", rel }
}

export const enumerateRepoSources = (repoRoot: string): string[] => {
  const out: string[] = []
  const stack: string[] = [repoRoot]
  while (stack.length > 0 && out.length < MAX_WALK_FILES) {
    const dir = stack.pop()
    if (dir === undefined) break
    let entries: Dirent[]
    try {
      // `withFileTypes: true` + string encoding returns Dirent<string>[];
      // the Node typings ship Dirent<Buffer | string> generics, so we
      // annotate explicitly to keep TS happy on every Node 20+ version.
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]
    } catch {
      continue
    }
    for (const e of entries) {
      const c = classifyDirent(e, dir, repoRoot)
      if (c === undefined) continue
      if (c.kind === "dir") stack.push(c.path)
      else out.push(c.rel)
    }
  }
  return out
}

const LSP_EXTENSION_TO_LANGUAGE = lspExtensionToLanguage()

interface BenchLspProbeTarget {
  readonly bin: string
  readonly rel: string
  readonly count: number
}

/** Dominant LSP-mapped language across `rels` (highest mapped-file count; ties
 *  broken by bin name so the pick is deterministic). Shared by the whole-repo
 *  probe and the task-relevant (gold-patch) probe. */
const dominantBinOf = (rels: Iterable<string>): BenchLspProbeTarget | undefined => {
  const bins = new Map<string, { rel: string; count: number }>()
  for (const rel of rels) {
    const bin = LSP_EXTENSION_TO_LANGUAGE.get(extname(rel).toLowerCase())
    if (bin === undefined) continue
    const seen = bins.get(bin)
    if (seen === undefined) bins.set(bin, { rel, count: 1 })
    else seen.count += 1
  }
  let best: BenchLspProbeTarget | undefined
  for (const [bin, info] of bins) {
    if (
      best === undefined ||
      info.count > best.count ||
      (info.count === best.count && byteCompare(bin, best.bin) < 0)
    ) {
      best = { bin, rel: info.rel, count: info.count }
    }
  }
  return best
}

const dominantLspProbeTarget = (repoRoot: string): BenchLspProbeTarget | undefined =>
  dominantBinOf(enumerateRepoSources(repoRoot))

export class StrictLspGroundingDegradedError extends Error {
  /** The typed grounding receipt that triggered the degrade (LSP-02), so the
   *  per-instance result can render the SAME status even though the gate threw
   *  before a {@link PreparedAttemptContext} existed. Absent for the pre-probe
   *  failures (missing binary / no mapped language / nav disabled) where no
   *  receipt was produced. */
  readonly receipt?: LspGroundingReceipt
  constructor(message: string, receipt?: LspGroundingReceipt) {
    super(message)
    this.name = "StrictLspGroundingDegradedError"
    if (receipt !== undefined) this.receipt = receipt
  }
}

export const verifyStrictPresetLspGrounding = async (
  posture: BenchPosture,
  sandbox: string,
  taskFiles?: readonly string[],
  signal?: AbortSignal,
): Promise<LspGroundingReceipt | undefined> => {
  const preset = posture.preset
  if (preset === undefined || !presetRequiresLiveLspGrounding(preset)) return undefined
  if (!posture.lspNav) {
    throw new StrictLspGroundingDegradedError(
      `[bench] preset ${preset} requires live LSP grounding, but LSP nav is disabled in the resolved posture.`,
    )
  }
  // Gate on the TASK-RELEVANT language first: the LSP server for the files THIS
  // instance actually edits (its gold-patch targets). A repo's incidental
  // C-extension subdir (astropy/utils/src/*.c) must NOT require clangd for a
  // Python task. The whole-repo fallback probe is a CAPPED (MAX_WALK_FILES),
  // filesystem-order-dependent walk whose "dominant" language flips between
  // identical runs (measured jun-21: astropy-7166 hard-failed turns=0 demanding
  // clangd on 1 of 3 identical runs). The gold-patch file list is small + stable,
  // so it identifies the worked-on language deterministically.
  const probe =
    (taskFiles !== undefined && taskFiles.length > 0 ? dominantBinOf(taskFiles) : undefined) ??
    dominantLspProbeTarget(sandbox)
  if (probe === undefined) {
    throw new StrictLspGroundingDegradedError(
      `[bench] preset ${preset} requires live LSP grounding, but this repo has no source file mapped to a configured language server.`,
    )
  }
  // Cheap launch preflight first (a missing binary needs no pool spawn).
  if (!(await lspBinaryAvailable(probe.bin))) {
    throw new StrictLspGroundingDegradedError(
      `[bench] preset ${preset} requires live LSP grounding, but ${probe.bin} is not launchable on PATH ` +
        `(dominant repo-language probe: ${probe.rel}, ${probe.count} file(s)).`,
    )
  }
  // READY proof (LSP-01): launchability is necessary but NOT sufficient. Drive
  // the real warm-backend readiness probe on the task-relevant anchor, in THIS
  // sandbox, so a launchable-but-cold workspace (ready_timeout / fatal transport)
  // fails the strict preset closed instead of silently degrading to no-nav. A
  // language with no warm pool returns a launch-stage `ok` (binary preflight is
  // the only authority there). An expected lifecycle cancel is non-fatal — the
  // attempt is being torn down anyway.
  const receipt = await proveStrictLspReady(join(sandbox, probe.rel), sandbox, probe.bin, signal)
  if (isRealGroundingFailure(receipt.outcome)) {
    throw new StrictLspGroundingDegradedError(
      `[bench] preset ${preset} requires live LSP grounding, but the task-relevant workspace did not ` +
        `reach verified-ready. ${renderLspGroundingStatus({
          backend: receipt.backend,
          language: receipt.language,
          [receipt.stage]: receipt.outcome,
          ...(receipt.durationMs !== undefined ? { durationMs: receipt.durationMs } : {}),
          ...(receipt.reason !== undefined ? { reason: receipt.reason } : {}),
        })} (anchor: ${probe.rel}).`,
      receipt,
    )
  }
  return receipt
}
