/**
 * External-agent import: shared types (ADR-0038, Cluster D Feature 4).
 *
 * Mirrors Codex's 4-stage lifecycle for importing sessions/skills from
 * other coding-agent tools. Each stage emits exactly one terminal event
 * (success XOR failure); the failure of any stage halts the lifecycle and
 * emits `import_finished` with `{ ok: false, error }`.
 */

import type { Id } from "@/shared"

/** Brand for external-agent session ids surfaced via import. Distinct from
 *  v3 session ids — they live in `~/.quanta/sessions/...`; imported ids
 *  live in `~/.quanta/external_agent_session_imports.json`. */
export type ExternalSessionId = Id<"ExternalSessionId">

/** 4 stages of the import lifecycle. Stage ordering is strict: a `provider_
 *  stage_finished` event MUST follow a `detect_finished` event for the same
 *  invocation; the validator in `importer.ts` enforces this. */
export type ImportStage =
  | "detect_finished"
  | "provider_stage_finished"
  | "session_completion_finished"
  | "import_finished"

/** Recognized external agent providers. `unknown` is NOT a fallback — it
 *  is what the detector returns when a provider directory exists but does
 *  not match any known provider's marker layout. Callers MUST handle
 *  `unknown` explicitly (e.g. log + skip); the importer rejects it. */
export type ExternalAgentProvider = "claude_code" | "cursor" | "aider" | "unknown"

/** All known providers as a readonly array — used by `detector.ts` to
 *  iterate and by the test suite to assert no `unknown` slips through. */
export const ALL_PROVIDERS: readonly ExternalAgentProvider[] = Object.freeze([
  "claude_code",
  "cursor",
  "aider",
  "unknown",
] as const)

/** A provider that the detector verified by inspecting marker files. */
export interface DetectedAgent {
  readonly provider: ExternalAgentProvider
  readonly root: string
  readonly markers: readonly string[]
}

/** Per-stage event payload schemas. Discriminated by `stage`. */
export type ImportEvent =
  | {
      readonly stage: "detect_finished"
      readonly ok: true
      readonly detected: readonly DetectedAgent[]
    }
  | {
      readonly stage: "detect_finished"
      readonly ok: false
      readonly error: string
    }
  | {
      readonly stage: "provider_stage_finished"
      readonly ok: true
      readonly provider: ExternalAgentProvider
      readonly sessionsDiscovered: number
    }
  | {
      readonly stage: "provider_stage_finished"
      readonly ok: false
      readonly provider: ExternalAgentProvider
      readonly error: string
    }
  | {
      readonly stage: "session_completion_finished"
      readonly ok: true
      readonly provider: ExternalAgentProvider
      readonly sessionsTranslated: number
      readonly skillsCounted: number
    }
  | {
      readonly stage: "session_completion_finished"
      readonly ok: false
      readonly provider: ExternalAgentProvider
      readonly error: string
    }
  | {
      readonly stage: "import_finished"
      readonly ok: true
      readonly result: ImportResult
    }
  | {
      readonly stage: "import_finished"
      readonly ok: false
      readonly error: string
    }

/** Final import result returned by `runImport`. */
export interface ImportResult {
  readonly provider: ExternalAgentProvider
  readonly sessionsTranslated: number
  readonly skillsCounted: number
  readonly errors: readonly string[]
}

/** Sink for stage events. The importer guarantees that events are emitted
 *  IN ORDER and that exactly one `import_finished` event terminates the
 *  sequence. */
export type ImportEventSink = (event: ImportEvent) => void

/** Persisted log of import attempts. Mirrors Codex's
 *  `external_agent_session_imports.json` shape. */
export interface ImportLogEntry {
  readonly timestamp: string
  readonly provider: ExternalAgentProvider
  readonly stage: ImportStage
  readonly ok: boolean
  readonly detail: string
}

export interface ImportLog {
  readonly version: 1
  readonly entries: readonly ImportLogEntry[]
}
