/**
 * Keystone — `buildEvidence` fuses every signal source into one
 * {@link EvidencePacket} for the LLM. It is a PURE orchestrator over injected
 * sources (run_tests / DAP / LSP / git), so it is fully testable with fakes and
 * the real ports are wired at the tool/composition layer.
 *
 * Contract:
 *  - run the suite; pick the TOP failure (first with a file+line, else first).
 *  - enrich ONLY that failure with static (LSP at the failure site) + runtime
 *    (DAP for the failing test). Each enrichment is best-effort.
 *  - green suite ⇒ failure null, no enrichment work.
 *  - EVERY source is independently optional AND fault-isolated: a missing or
 *    THROWING source degrades its section to null/[], never the whole packet.
 *  NEVER throws.
 */
import type { TestRunResult, Toolchain } from "../testrun"
import type { EvidencePacket, FailureEvidence, PatchConstraints, RuntimeEvidence, StaticEvidence } from "./types"

export interface EvidenceSources {
  /** Detect the project toolchain (language + test command). */
  detect: (cwd: string) => Promise<Toolchain | null>
  /** Run the suite and return the normalized result. */
  runTests: (tc: Toolchain, cwd: string) => Promise<TestRunResult>
  /** LSP static context at a failure site (optional). */
  lspStatic?: (file: string, line: number, cwd: string) => Promise<StaticEvidence | null>
  /** DAP runtime state for the failing test (optional). */
  runtime?: (failure: FailureEvidence, cwd: string) => Promise<RuntimeEvidence | null>
  /** Repo changed files, e.g. `git diff --name-only` (optional). */
  changedFiles?: (cwd: string) => Promise<readonly string[]>
}

export interface BuildEvidenceOptions {
  readonly patchConstraints?: PatchConstraints
}

const DEFAULT_CONSTRAINTS: PatchConstraints = { public_api_change_allowed: false }

/** Run an optional async source, swallowing any fault to `fallback` (a source
 *  crash must never break the packet). */
const safe = async <T>(fn: (() => Promise<T>) | undefined, fallback: T): Promise<T> => {
  if (fn === undefined) return fallback
  try {
    return await fn()
  } catch {
    return fallback
  }
}

export const buildEvidence = async (
  cwd: string,
  sources: EvidenceSources,
  opts: BuildEvidenceOptions = {},
): Promise<EvidencePacket> => {
  const patch_constraints = opts.patchConstraints ?? DEFAULT_CONSTRAINTS
  const changed_files = await safe(sources.changedFiles ? () => sources.changedFiles!(cwd) : undefined, [])

  const tc = await safe(() => sources.detect(cwd), null)
  const empty: EvidencePacket = {
    language: tc?.kind ?? "unknown",
    repo_context: { changed_files: [...changed_files], diagnostics: [] },
    failure: null,
    runtime: null,
    static: null,
    patch_constraints,
  }
  if (tc === null) return empty

  const result = await safe(() => sources.runTests(tc, cwd), null)
  // No result OR a green suite ⇒ nothing to localize.
  if (result === null || result.failed.length === 0) return empty

  // TOP failure: prefer the first with a concrete file+line (localizable).
  const top = result.failed.find((f) => f.file !== undefined && f.line !== undefined) ?? result.failed[0]!
  const failure: FailureEvidence = {
    command: tc.command.join(" "),
    test_name: top.name,
    ...(top.message !== undefined ? { message: top.message } : {}),
    ...(top.file !== undefined ? { file: top.file } : {}),
    ...(top.line !== undefined ? { line: top.line } : {}),
  }

  // Enrich ONLY when the failure is localizable (file+line) for static; runtime
  // is keyed by the failing test name.
  const staticEv =
    top.file !== undefined && top.line !== undefined && sources.lspStatic !== undefined
      ? await safe(() => sources.lspStatic!(top.file!, top.line!, cwd), null)
      : null
  const runtimeEv =
    sources.runtime !== undefined ? await safe(() => sources.runtime!(failure, cwd), null) : null

  return {
    language: tc.kind,
    repo_context: { changed_files: [...changed_files], diagnostics: staticEv?.diagnostics ?? [] },
    failure,
    runtime: runtimeEv,
    static: staticEv,
    patch_constraints,
  }
}
