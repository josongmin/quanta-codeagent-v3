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
import { isAbsolute, resolve } from "node:path"
import type { TestRunResult, Toolchain } from "../testrun"
import type { EvidencePacket, FailureEvidence, PatchConstraints, RuntimeEvidence, StaticEvidence } from "./types"

export interface EvidenceSources {
  /** Detect the project toolchain (language + test command). */
  detect: (cwd: string) => Promise<Toolchain | null>
  /** Run the suite and return the normalized result. */
  runTests: (tc: Toolchain, cwd: string) => Promise<TestRunResult>
  /** LSP static context at a failure site (optional). Receives the turn signal
   *  (so a cancelled turn doesn't keep an indexing-retry loop querying a live
   *  LSP child for the rest of its budget). */
  lspStatic?: (file: string, line: number, cwd: string, signal?: AbortSignal) => Promise<StaticEvidence | null>
  /** DAP runtime state for the failing test (optional). Receives the toolchain
   *  (to build the right "run under the debugger" launch) + the turn signal (so a
   *  long debugger run aborts with the turn). */
  runtime?: (
    failure: FailureEvidence,
    tc: Toolchain,
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<RuntimeEvidence | null>
  /** Repo changed files, e.g. `git diff --name-only` (optional). */
  changedFiles?: (cwd: string) => Promise<readonly string[]>
}

export interface BuildEvidenceOptions {
  readonly patchConstraints?: PatchConstraints
  /** Turn-abort signal, threaded to the runtime (debugger) AND lspStatic
   *  sources so a cancelled turn doesn't wait out the debugger stop-timeout or
   *  the LSP indexing-retry budget. */
  readonly signal?: AbortSignal
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
  // `result.failed` is non-empty here (guarded above), but avoid the `!` so a
  // future parser contract change can't turn this into a crash.
  const top = result.failed.find((f) => f.file !== undefined && f.line !== undefined) ?? result.failed[0]
  if (top === undefined) return empty
  const failure: FailureEvidence = {
    command: tc.command.join(" "),
    test_name: top.name,
    ...(top.message !== undefined ? { message: top.message } : {}),
    ...(top.file !== undefined ? { file: top.file } : {}),
    ...(top.line !== undefined ? { line: top.line } : {}),
  }

  // Enrich ONLY when the failure is localizable (file+line) for static; runtime
  // is keyed by the failing test name. The file is normalized to an ABSOLUTE
  // path before handoff — test runners report it relative to cwd, but LSP/DAP
  // need an absolute path (a relative one silently fails to bind/hover).
  const absFile = top.file !== undefined ? (isAbsolute(top.file) ? top.file : resolve(cwd, top.file)) : undefined
  const staticEv =
    absFile !== undefined && top.line !== undefined && sources.lspStatic !== undefined
      ? await safe(() => sources.lspStatic!(absFile, top.line!, cwd, opts.signal), null)
      : null
  const runtimeEv =
    sources.runtime !== undefined ? await safe(() => sources.runtime!(failure, tc, cwd, opts.signal), null) : null

  return {
    language: tc.kind,
    repo_context: { changed_files: [...changed_files], diagnostics: staticEv?.diagnostics ?? [] },
    failure,
    runtime: runtimeEv,
    static: staticEv,
    patch_constraints,
  }
}
