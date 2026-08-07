/**
 * RFC-12-2 wiring — the CLI composition root's LIVE-source adapters for the
 * three `@`-mention kinds that RFC-12-2 built but left DARK: `@mcp:`,
 * `@subagent:`, `@thread:`. The resolver/provider seams already accept injected
 * owners; this module is the single place that projects the host's ALREADY-LIVE
 * sources onto BOTH consumers so the two never drift:
 *
 *   - RESOLVER owners (`buildDefaultMentionResolver`): `mcpListing` /
 *     `subagents` / `threadSummary` — what `@mcp:x` / `@subagent:x` /
 *     `@thread:x` resolve into an injected context fragment on submit.
 *   - PROVIDER listers (`createCompositeAtProvider`): `listMcpServers` /
 *     `listSubagents` / `listThreads` — what the `@`-autocomplete dropdown
 *     surfaces as candidates.
 *
 * LIVE SOURCES (NO new store/registry — owner reuse per RFC-12-2):
 *   - MCP: the host's loaded-MCP result (`loadMcpTools` → the `/mcp` surface
 *     projection `McpServerInfo[]`: server name → its bridged `McpToolInfo[]`).
 *   - Subagent: the EXISTING `NamedAgentResolver` (`loadNamedAgents(cwd)` →
 *     `NamedAgentRegistry`), the same read-only port the subagent runner
 *     consults for spawn-time role identity.
 *   - Thread: the live session store (`listSessions` → `SessionMeta`).
 *
 * PER-KIND KILL-SWITCHES: each kind rides its `QUANTA_MENTION_{MCP,SUBAGENT,
 * THREAD}` knob (default-ON; `=off` opts out). The RESOLVER honours these
 * downstream in `buildDefaultMentionResolver`, so the resolver-owner projection
 * passes the owners through unconditionally (the builder gates). The PROVIDER
 * has no such downstream gate, so THIS module gates the provider listers on the
 * same knobs — a `=off` kind contributes zero autocomplete candidates AND
 * resolves null, exactly matching the resolver behaviour.
 *
 * BYTE-IDENTICAL: an ABSENT source (no MCP configured / no `.quanta/agents` /
 * session-list load fault) ⇒ that owner is omitted / its lister returns `[]`,
 * so the kind is dark — identical to the pre-wire path. `QUANTA_AT_AUTOCOMPLETE`
 * still gates the autocomplete surface as a whole (upstream).
 *
 * FOREIGN-LINEAGE SAFETY (RFC-07): the subagent source is the repo-controlled
 * `NamedAgentResolver` — it only ever holds THIS workspace's declared role
 * definitions (`.quanta/agents` / `.claude/agents`), never another task's live
 * child roster. There is no cross-task child handle to surface or leak.
 */

import type { NamedAgentResolver } from "@/agent"
import type { BuildDefaultMentionResolverOptions } from "@/agent/mention-runner"
import type { McpToolInfo, ThreadSummary } from "@/agent/plugin-app-resolver"
import { errMessage, logger, parseEnvFlag } from "@/shared"

/** A `name + description` autocomplete registry entry (+ optional insert-payload
 *  override). Structurally identical to `apps/cli/at-autocomplete#NamedEntry`,
 *  re-declared HOST-side because the host layer cannot import `apps/cli` (the
 *  arrow runs apps/cli → host, per `host/bootstrap/types.ts`). The apps/cli
 *  provider consumes these structurally. */
export interface NamedEntry {
  readonly name: string
  readonly description: string
  /** RFC-12-2 — payload spliced AFTER the sigil when it differs from the label
   *  (the thread lister: label = title, payload = opaque session id). */
  readonly insertName?: string
}

/** Env bag the gates read (a plain record so tests can pass a hermetic view). */
export type MentionSourceEnv = Readonly<Record<string, string | undefined>>

/** Read-only projection of ONE loaded MCP server — the structural subset of the
 *  `/mcp` surface's `McpServerInfo` this builder needs (name + bridged tools).
 *  Re-declared locally so this module depends only on the shape, not the CLI
 *  `mcp-cmd` surface types. */
export interface McpServerSnapshot {
  readonly name: string
  readonly tools: readonly McpToolInfo[]
}

/** Read-only projection of the live session list — a thunk the host binds to
 *  `listSessions()` (async). Absent ⇒ no `@thread:` source. */
export type SessionListSource = () => Promise<readonly ThreadSummary[]>

/** The three LIVE sources the CLI composition root supplies. Each is OPTIONAL:
 *  an absent source ⇒ that kind is dark (byte-identical). */
export interface MentionLiveSources {
  /** Snapshot of loaded MCP servers (from `loadMcpTools` → `/mcp` projection).
   *  Absent / empty ⇒ no `@mcp:` candidates + `@mcp:` resolves null. */
  readonly mcpServers?: readonly McpServerSnapshot[]
  /** The repo-controlled named-agent registry (`loadNamedAgents(cwd)`). Absent
   *  ⇒ no `@subagent:` candidates + `@subagent:` resolves null. */
  readonly subagents?: NamedAgentResolver
  /** The live session-list thunk (`listSessions`). Absent ⇒ no `@thread:`
   *  candidates + `@thread:` resolves null. */
  readonly sessions?: SessionListSource
}

/** A knob is ON unless explicitly disabled (`0`/`false`/`off`/`no`). Delegates
 *  to the canonical `parseEnvFlag` so the falsey set matches the resolver's own
 *  `isOn` and every other default-ON mention knob. */
const isOn = (env: MentionSourceEnv, key: string): boolean =>
  parseEnvFlag(env[key], /* defaultOn */ true)

/** First non-empty line of a description (LF / CRLF tolerant). Mirrors the
 *  resolver / provider `firstLineOf` idiom. Pure. */
const firstLineOf = (text: string | undefined): string => {
  if (typeof text !== "string" || text.length === 0) return ""
  const nl = text.search(/\r?\n/)
  return (nl < 0 ? text : text.slice(0, nl)).trim()
}

// ── RESOLVER owners ───────────────────────────────────────────────────────

/** Project the MCP snapshot into an `McpServerListingPort`: `server → tools`,
 *  or `null` for an unknown server (⇒ the `@mcp:` mention is skipped). Case
 *  and shape mirror the resolver contract (empty array = known-but-empty). */
const mcpListingFor = (
  servers: readonly McpServerSnapshot[],
): NonNullable<BuildDefaultMentionResolverOptions["mcpListing"]> => {
  const byName = new Map<string, readonly McpToolInfo[]>()
  for (const s of servers) if (typeof s?.name === "string") byName.set(s.name, s.tools ?? [])
  return async (server: string) => byName.get(server) ?? null
}

/** Project the live session list into a `ThreadSummaryPort`: `id → summary`, or
 *  `null` for an unknown id. Reads the list once per lookup (the session store's
 *  own IO); a load fault ⇒ every id resolves `null` (NO-THROW). */
const threadSummaryFor = (
  sessions: SessionListSource,
): NonNullable<BuildDefaultMentionResolverOptions["threadSummary"]> => {
  return async (id: string) => {
    if (typeof id !== "string" || id.length === 0) return null
    try {
      const all = await sessions()
      return all.find((m) => m.id === id) ?? null
    } catch (e) {
      // Session-list load fault ⇒ id resolves null (NO-THROW mention resolver),
      // but a failing session store is a real (non-fatal) defect, surfaced at warn.
      logger.warn(`mention-thread-summary: session load failed: ${errMessage(e)}`)
      return null
    }
  }
}

/** Build the RESOLVER-owner slots (`mcpListing` / `subagents` / `threadSummary`)
 *  for `buildDefaultMentionResolver` from the live sources. The per-kind knobs
 *  are honoured DOWNSTREAM by the builder, so this passes owners through by
 *  presence only (an absent source ⇒ slot omitted ⇒ that kind resolves null,
 *  byte-identical). */
export const buildMentionResolverOwners = (
  sources: MentionLiveSources,
): Pick<BuildDefaultMentionResolverOptions, "mcpListing" | "subagents" | "threadSummary"> => {
  const hasMcp = sources.mcpServers !== undefined && sources.mcpServers.length > 0
  return {
    ...(hasMcp
      ? { mcpListing: mcpListingFor(sources.mcpServers as readonly McpServerSnapshot[]) }
      : {}),
    ...(sources.subagents !== undefined ? { subagents: sources.subagents } : {}),
    ...(sources.sessions !== undefined
      ? { threadSummary: threadSummaryFor(sources.sessions) }
      : {}),
  }
}

// ── PROVIDER listers ──────────────────────────────────────────────────────

/** Project the MCP snapshot into the autocomplete lister: one entry per server
 *  (`@mcp:<name>`), detail = a tool-count summary. */
const listMcpFor = (servers: readonly McpServerSnapshot[]): (() => readonly NamedEntry[]) => {
  const entries: NamedEntry[] = servers
    .filter((s) => typeof s?.name === "string" && s.name.length > 0)
    .map((s) => {
      const n = s.tools?.length ?? 0
      return { name: s.name, description: `${n} tool${n === 1 ? "" : "s"}` }
    })
  return () => entries
}

/** Project the named-agent registry into the autocomplete lister: one entry per
 *  registered role (`@subagent:<agentType>`), detail = the role's first line.
 *  RFC-07: only THIS repo's declared roles — no cross-task child handles. */
const listSubagentsFor = (registry: NamedAgentResolver): (() => readonly NamedEntry[]) => {
  return () => {
    // The read-only port only guarantees `resolve` (+ optional `names`); the
    // concrete `NamedAgentRegistry` also exposes `all()` with the bodies. Use
    // `all()` when present (bodies → detail line), else fall back to `names()`.
    const all = (registry as { all?: () => readonly { agentType: string; system: string }[] }).all
    if (typeof all === "function") {
      return all.call(registry).map((d) => ({
        name: d.agentType,
        description: firstLineOf(d.system),
      }))
    }
    const names = registry.names?.() ?? []
    return names.map((n) => ({ name: n, description: "" }))
  }
}

/** Project the session snapshot into the autocomplete lister: one entry per
 *  prior thread. The dropdown LABEL is the human title (`name`); the INSERTED
 *  payload is the opaque session id (`insertName`) the `@thread:` resolver looks
 *  up (RFC-12-2 `insertName` override). Detail = branch / cwd provenance.
 *  Async snapshot resolved by the caller (see {@link buildMentionProviderListers}). */
const listThreadsFrom = (threads: readonly ThreadSummary[]): readonly NamedEntry[] =>
  threads
    .filter((m) => typeof m?.id === "string" && m.id.length > 0)
    .map((m) => {
      const title = typeof m.title === "string" && m.title.length > 0 ? m.title : "(untitled)"
      const detail = m.gitBranch ?? m.cwd ?? m.threadSource ?? ""
      return { name: title, description: detail, insertName: m.id }
    })

/** The PROVIDER listers passed to `createCompositeAtProvider`. Each is present
 *  only when its source AND its per-kind knob are on. */
export interface MentionProviderListers {
  readonly listMcpServers?: () => readonly NamedEntry[]
  readonly listSubagents?: () => readonly NamedEntry[]
  readonly listThreads?: () => readonly NamedEntry[]
}

/**
 * Build the PROVIDER (autocomplete) listers from the live sources, gated per
 * kind on `QUANTA_MENTION_{MCP,SUBAGENT,THREAD}` (default-ON; `=off` ⇒ the
 * lister is OMITTED ⇒ zero candidates for that kind, matching the resolver's
 * downstream gate). An absent source ⇒ omitted too (byte-identical).
 *
 * The `@thread:` source is async (`listSessions`), but the provider listers are
 * SYNCHRONOUS. So the thread snapshot is captured ONCE at build time (the CLI
 * composes the provider per prompt-turn) and the sync lister reads that snapshot
 * — the same "read at wire time" posture the MCP snapshot uses.
 */
export const buildMentionProviderListers = async (
  sources: MentionLiveSources,
  env: MentionSourceEnv,
): Promise<MentionProviderListers> => {
  const mcpOn =
    isOn(env, "QUANTA_MENTION_MCP") &&
    sources.mcpServers !== undefined &&
    sources.mcpServers.length > 0
  const subagentOn = isOn(env, "QUANTA_MENTION_SUBAGENT") && sources.subagents !== undefined
  let threadLister: (() => readonly NamedEntry[]) | undefined
  if (isOn(env, "QUANTA_MENTION_THREAD") && sources.sessions !== undefined) {
    // Snapshot the session list ONCE (async) so the sync lister can serve it.
    // A load fault ⇒ empty snapshot ⇒ zero candidates (NO-THROW).
    let snapshot: readonly ThreadSummary[] = []
    try {
      snapshot = await sources.sessions()
    } catch {
      snapshot = []
    }
    const entries = listThreadsFrom(snapshot)
    threadLister = () => entries
  }
  return {
    ...(mcpOn
      ? { listMcpServers: listMcpFor(sources.mcpServers as readonly McpServerSnapshot[]) }
      : {}),
    ...(subagentOn
      ? { listSubagents: listSubagentsFor(sources.subagents as NamedAgentResolver) }
      : {}),
    ...(threadLister !== undefined ? { listThreads: threadLister } : {}),
  }
}
