/**
 * External-agent import: shared types (ADR-0038, Cluster D Feature 4).
 *
 * Mirrors Codex's 4-stage lifecycle for importing sessions/skills from
 * other coding-agent tools. Each stage emits exactly one terminal event
 * (success XOR failure); the failure of any stage halts the lifecycle and
 * emits `import_finished` with `{ ok: false, error }`.
 */

import type { Message } from "@/llm"
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

/** One translated session transcript, ready for the caller to persist into
 *  the v3 session store. The migration slice CANNOT import `@/session`
 *  (ADR-0038 slice isolation), so it returns the translated payload and the
 *  CLI surface adapter owns persistence. `contentHash` is the SHA-256 of the
 *  source transcript bytes — the dedup key (ADR-0430). */
export interface TranslatedSession {
  /** Absolute path of the source `*.jsonl` transcript. */
  readonly sourcePath: string
  /** SHA-256 (hex) of the raw source bytes — stable dedup fingerprint. */
  readonly contentHash: string
  /** Translated v3 messages (may be empty for a stub-provider transcript). */
  readonly messages: readonly Message[]
}

/** A Claude Code MCP server config entry, translated to the kinds quanta has
 *  an equivalent for (stdio-launched servers). HTTP/SSE servers are reported
 *  with `transport` so a caller can skip the ones quanta doesn't model. */
export interface TranslatedMcpServer {
  readonly name: string
  readonly transport: "stdio" | "http" | "sse" | "unknown"
  /** Launch command for stdio servers; undefined for non-stdio transports. */
  readonly command?: string
  readonly args?: readonly string[]
}

/** A translated hook binding. Claude Code stores hooks under
 *  `settings.json#hooks.<EventName>[]`; we translate event name + the matcher
 *  + the shell command(s). */
export interface TranslatedHook {
  readonly event: string
  readonly matcher?: string
  readonly commands: readonly string[]
}

/** A translated repo-rule document (Claude Code `CLAUDE.md` memory file). */
export interface TranslatedRule {
  readonly sourcePath: string
  readonly contentHash: string
  readonly text: string
}

/** Final import result returned by `runImport`. */
export interface ImportResult {
  readonly provider: ExternalAgentProvider
  readonly sessionsTranslated: number
  readonly skillsCounted: number
  /** Per-session translated payloads (the data the caller persists). Length
   *  equals `sessionsTranslated`. */
  readonly sessions: readonly TranslatedSession[]
  /** Translated MCP server configs (only kinds quanta models; see
   *  {@link TranslatedMcpServer}). Empty when the source has no `.mcp.json`. */
  readonly mcpServers: readonly TranslatedMcpServer[]
  /** Translated hook bindings from the source `settings.json`. */
  readonly hooks: readonly TranslatedHook[]
  /** Translated repo-rule documents (CLAUDE.md memory files). */
  readonly rules: readonly TranslatedRule[]
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
  /** ADR-0430 dedup: SHA-256 of an imported item's source bytes. Present on
   *  per-item rows written after a successful persist; absent on the summary
   *  row. Re-import consults these to skip already-imported items. */
  readonly contentHash?: string
  /** The kind of item this row fingerprints (`session` | `rule`). Lets the
   *  dedup query scope the hash lookup. Absent on the summary row. */
  readonly itemKind?: "session" | "rule"
}

export interface ImportLog {
  readonly version: 1
  readonly entries: readonly ImportLogEntry[]
}
