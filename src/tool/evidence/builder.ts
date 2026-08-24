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
import type { TestFailure, TestRunResult, Toolchain } from "../testrun"
import type {
  EvidencePacket,
  FailureEvidence,
  PatchConstraints,
  RuntimeEvidence,
  StaticEvidence,
} from "./types"

export interface EvidenceSources {
  /** Detect the project toolchain (language + test command). */
  detect: (cwd: string) => Promise<Toolchain | null>
  /** Run the suite and return the normalized result. */
  runTests: (tc: Toolchain, cwd: string) => Promise<TestRunResult>
  /** LSP static context at a failure site (optional). Receives the turn signal
   *  (so a cancelled turn doesn't keep an indexing-retry loop querying a live
   *  LSP child for the rest of its budget). */
  lspStatic?: (
    file: string,
    line: number,
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<StaticEvidence | null>
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

/**
 * Project the top failing test into the packet's failure evidence.
 *
 * A unit because the three optional fields are one contract with the consumer: each is
 * OMITTED rather than set to `undefined` (`exactOptionalPropertyTypes`), so a packet
 * never claims to carry a message/file/line it does not have. Spelling that out at the
 * point of use is how one of them drifts into an explicit `undefined`.
 */
const toFailureEvidence = (top: TestFailure, tc: Toolchain): FailureEvidence => ({
  command: tc.command.join(" "),
  test_name: top.name,
  ...(top.message !== undefined ? { message: top.message } : {}),
  ...(top.file !== undefined ? { file: top.file } : {}),
  ...(top.line !== undefined ? { line: top.line } : {}),
})

/**
 * The failing test's file as an ABSOLUTE path, or undefined when it reported none.
 *
 * A unit because the normalization is load-bearing, not cosmetic: runners report the
 * file relative to cwd, and LSP/DAP silently fail to bind or hover on a relative path —
 * a failure mode with no error, just empty enrichment.
 */
const absoluteFailureFile = (file: string | undefined, cwd: string): string | undefined => {
  if (file === undefined) return undefined
  return isAbsolute(file) ? file : resolve(cwd, file)
}

export const buildEvidence = async (
  cwd: string,
  sources: EvidenceSources,
  opts: BuildEvidenceOptions = {},
): Promise<EvidencePacket> => {
  const patch_constraints = opts.patchConstraints ?? DEFAULT_CONSTRAINTS
  // Bound before the closure — see the note on `lspStatic` below: narrowing a
  // mutable property does not survive into an arrow body.
  const changedFiles = sources.changedFiles
  const changed_files = await safe(changedFiles ? () => changedFiles(cwd) : undefined, [])

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
  const top =
    result.failed.find((f) => f.file !== undefined && f.line !== undefined) ?? result.failed[0]
  if (top === undefined) return empty
  const failure: FailureEvidence = toFailureEvidence(top, tc)

  // Enrich ONLY when the failure is localizable (file+line) for static; runtime
  // is keyed by the failing test name. The file is normalized to an ABSOLUTE
  // path before handoff — test runners report it relative to cwd, but LSP/DAP
  // need an absolute path (a relative one silently fails to bind/hover).
  const absFile = absoluteFailureFile(top.file, cwd)
  // Bound to consts before the closures: narrowing a MUTABLE property
  // (`sources.lspStatic !== undefined`, `top.line !== undefined`) does not
  // survive into an arrow body, which is the only reason these reads carried
  // non-null assertions. A const holds the narrowing, so the guard above is what
  // proves the call is safe rather than an assertion restating it.
  const lspStatic = sources.lspStatic
  const runtime = sources.runtime
  const topLine = top.line
  const staticEv =
    absFile !== undefined && topLine !== undefined && lspStatic !== undefined
      ? await safe(() => lspStatic(absFile, topLine, cwd, opts.signal), null)
      : null
  const runtimeEv =
    runtime !== undefined ? await safe(() => runtime(failure, tc, cwd, opts.signal), null) : null

  return {
    language: tc.kind,
    repo_context: { changed_files: [...changed_files], diagnostics: staticEv?.diagnostics ?? [] },
    failure,
    runtime: runtimeEv,
    static: staticEv,
    patch_constraints,
  }
}
