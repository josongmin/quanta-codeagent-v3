/**
 * External-agent importer (ADR-0038, Cluster D Feature 4).
 *
 * Runs the 4-stage lifecycle for a single provider. The implementation here
 * is the SHAPE (event sequencing, halt-on-error semantics, result tally) —
 * provider-specific session parsing is intentionally minimal (we count
 * marker-present session files) because the brief scopes real provider
 * import to a fixture in tests + follow-up work (ADR-0038 §한계).
 */

import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { QuantaError } from "@/shared"
import { detectExternalAgents } from "./detector"
import type { ExternalAgentProvider, ImportEventSink, ImportResult } from "./types"

/** Caller-side options for `runImport`. */
export interface RunImportOptions {
  readonly homeDir: string
  /** Whether to import skills as well as sessions. Default `true` for
   *  Claude Code (it has a `skills/` subdir); other providers ignore. */
  readonly includeSkills?: boolean
}

/** Thrown when `runImport` is called with `provider: "unknown"`. The
 *  `unknown` enum value is for caller-driven probing only; the importer
 *  refuses it to make a silent-fallback bug impossible. */
export class UnknownProviderRejectedError extends QuantaError {
  constructor() {
    super(
      "unknown_provider_rejected",
      `runImport refuses provider="unknown". Detect first, then call runImport ` +
        `with a concrete provider; "unknown" exists only as a typed sentinel.`,
    )
  }
}

/** Stage 1: detect. */
const stageDetect = async (
  homeDir: string,
  provider: Exclude<ExternalAgentProvider, "unknown">,
  emit: ImportEventSink,
): Promise<{ ok: true; root: string } | { ok: false }> => {
  try {
    const all = await detectExternalAgents(homeDir)
    const match = all.find((d) => d.provider === provider)
    if (match === undefined) {
      emit({
        stage: "detect_finished",
        ok: false,
        error: `Provider "${provider}" not found under ${homeDir}.`,
      })
      return { ok: false }
    }
    emit({ stage: "detect_finished", ok: true, detected: [match] })
    return { ok: true, root: match.root }
  } catch (err) {
    emit({
      stage: "detect_finished",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false }
  }
}

/** Stage 2: per-provider session discovery. Counts session files under the
 *  provider's `projects/` subdir (Claude Code shape) — other providers
 *  ship parallel logic in the follow-up. */
const stageProvider = async (
  root: string,
  provider: Exclude<ExternalAgentProvider, "unknown">,
  emit: ImportEventSink,
): Promise<{ ok: true; sessionsDiscovered: number } | { ok: false }> => {
  try {
    const sessionsDir = provider === "claude_code" ? join(root, "projects") : join(root, "sessions")
    let entries: string[]
    try {
      entries = await readdir(sessionsDir)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") entries = []
      else throw err
    }
    let count = 0
    for (const entry of entries) {
      const st = await stat(join(sessionsDir, entry))
      if (st.isDirectory() || st.isFile()) count++
    }
    emit({
      stage: "provider_stage_finished",
      ok: true,
      provider,
      sessionsDiscovered: count,
    })
    return { ok: true, sessionsDiscovered: count }
  } catch (err) {
    emit({
      stage: "provider_stage_finished",
      ok: false,
      provider,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false }
  }
}

/** Stage 3: session completion — would actually parse each session into v3
 *  shape. Brief scopes this to: count = discovered (1:1 import), skills
 *  count via `skills/` subdir if present and opted-in. */
const stageSessionCompletion = async (
  root: string,
  provider: Exclude<ExternalAgentProvider, "unknown">,
  sessionsDiscovered: number,
  includeSkills: boolean,
  emit: ImportEventSink,
): Promise<{ ok: true; sessionsImported: number; skillsImported: number } | { ok: false }> => {
  try {
    let skillsImported = 0
    if (includeSkills) {
      const skillsDir = join(root, "skills")
      try {
        const entries = await readdir(skillsDir)
        skillsImported = entries.length
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "ENOENT") throw err
      }
    }
    emit({
      stage: "session_completion_finished",
      ok: true,
      provider,
      sessionsImported: sessionsDiscovered,
      skillsImported,
    })
    return { ok: true, sessionsImported: sessionsDiscovered, skillsImported }
  } catch (err) {
    emit({
      stage: "session_completion_finished",
      ok: false,
      provider,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false }
  }
}

/** Run the full 4-stage import. Halts on first stage failure with a final
 *  `import_finished { ok:false }` event. */
export const runImport = async (
  provider: ExternalAgentProvider,
  opts: RunImportOptions,
  emit: ImportEventSink,
): Promise<ImportResult> => {
  if (provider === "unknown") throw new UnknownProviderRejectedError()

  const includeSkills = opts.includeSkills !== false

  const det = await stageDetect(opts.homeDir, provider, emit)
  if (!det.ok) {
    const r: ImportResult = {
      provider,
      sessionsImported: 0,
      skillsImported: 0,
      errors: ["detect_finished failed"],
    }
    emit({ stage: "import_finished", ok: false, error: "detect_finished failed" })
    return r
  }

  const ps = await stageProvider(det.root, provider, emit)
  if (!ps.ok) {
    const r: ImportResult = {
      provider,
      sessionsImported: 0,
      skillsImported: 0,
      errors: ["provider_stage_finished failed"],
    }
    emit({
      stage: "import_finished",
      ok: false,
      error: "provider_stage_finished failed",
    })
    return r
  }

  const sc = await stageSessionCompletion(
    det.root,
    provider,
    ps.sessionsDiscovered,
    includeSkills,
    emit,
  )
  if (!sc.ok) {
    const r: ImportResult = {
      provider,
      sessionsImported: 0,
      skillsImported: 0,
      errors: ["session_completion_finished failed"],
    }
    emit({
      stage: "import_finished",
      ok: false,
      error: "session_completion_finished failed",
    })
    return r
  }

  const result: ImportResult = {
    provider,
    sessionsImported: sc.sessionsImported,
    skillsImported: sc.skillsImported,
    errors: [],
  }
  emit({ stage: "import_finished", ok: true, result })
  return result
}
