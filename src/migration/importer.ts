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
import { translatorFor } from "./translators"
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

/** Recursively collect every `*.jsonl` transcript path under `dir`. Claude
 *  Code lays sessions out as `projects/<slug>/<id>.jsonl`; we walk the tree
 *  so nested project slugs are covered. ENOENT ⇒ empty (no sessions dir). */
const collectJsonlPaths = async (dir: string): Promise<string[]> => {
  let entries: Array<{ name: string; isDir: boolean }>
  try {
    const dirents = await readdir(dir, { withFileTypes: true })
    entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return []
    throw err
  }
  const out: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDir) {
      out.push(...(await collectJsonlPaths(full)))
    } else if (entry.name.endsWith(".jsonl")) {
      out.push(full)
    }
  }
  return out.sort()
}

/** Count importable skills under `<root>/skills`. ENOENT (no skills dir) ⇒ 0;
 *  any other error propagates to the caller's try/catch. Returns 0 when
 *  `includeSkills` is false (caller opted out). */
const countSkills = async (root: string, includeSkills: boolean): Promise<number> => {
  if (!includeSkills) return 0
  try {
    const entries = await readdir(join(root, "skills"))
    return entries.length
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return 0
    throw err
  }
}

/** Stage 3: session completion — translate each provider session transcript
 *  into v3 `Message[]` via the provider translator (L4). Sessions are
 *  discovered as `*.jsonl` files under `projects/` (claude_code) / `sessions/`
 *  (others). Halt-on-error: the FIRST translation failure emits
 *  `session_completion_finished {ok:false}` and returns. A successfully
 *  translated session is counted regardless of message count (a zero-message
 *  but well-formed transcript still imports). Skills counting via the
 *  `skills/` subdir is preserved unchanged. */
const stageSessionCompletion = async (
  root: string,
  provider: Exclude<ExternalAgentProvider, "unknown">,
  includeSkills: boolean,
  emit: ImportEventSink,
): Promise<{ ok: true; sessionsImported: number; skillsImported: number } | { ok: false }> => {
  try {
    const sessionsDir = provider === "claude_code" ? join(root, "projects") : join(root, "sessions")
    const jsonlPaths = await collectJsonlPaths(sessionsDir)
    const translator = translatorFor(provider)

    let sessionsImported = 0
    for (const path of jsonlPaths) {
      try {
        // Translation result (Message[]) is intentionally not persisted here —
        // the importer's contract is to PROVE the transcript translates and
        // tally it; persistence into v3 sessions is the follow-up. A throw is
        // a halt-on-error condition.
        await translator.translateFromFile(path, provider)
        sessionsImported++
      } catch (err) {
        emit({
          stage: "session_completion_finished",
          ok: false,
          provider,
          error: `translate ${path}: ${err instanceof Error ? err.message : String(err)}`,
        })
        return { ok: false }
      }
    }

    const skillsImported = await countSkills(root, includeSkills)
    emit({
      stage: "session_completion_finished",
      ok: true,
      provider,
      sessionsImported,
      skillsImported,
    })
    return { ok: true, sessionsImported, skillsImported }
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

  const sc = await stageSessionCompletion(det.root, provider, includeSkills, emit)
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
