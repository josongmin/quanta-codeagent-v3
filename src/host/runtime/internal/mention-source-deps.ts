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
 *   - Thread: the live session store (`listSessions` → `SessionMeta`), SCOPED to
 *     the CALLER's lineage (B4 / jul-15 sibling-leak class — see below).
 *
 * B4 LINEAGE SCOPE (aug-10 security fix — the jul-15 sibling-leak class):
 * the `@thread:` resolver + enumerator resolve ONLY threads inside the caller's
 * lineage — `self ∪ transitive-ancestors ∪ transitive-descendants` over the
 * `SessionMeta.forkedFromId` fork chain (the only parentage edge a persisted
 * user session carries). A SIBLING (forked from the same parent as the caller
 * but neither an ancestor nor a descendant) or an UNRELATED thread resolves
 * `null` and never appears as an autocomplete candidate. FAIL-CLOSED: when the
 * caller's own thread id (`selfThreadId`) is ABSENT the lineage set cannot be
 * computed, so the scope is EMPTY and every `@thread:` id resolves `null` — the
 * tightening is a strict subset, never a widening. Bounded to METADATA
 * (title/cwd/branch/source) even in-lineage; the transcript is never surfaced.
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
  /** B4 lineage scope — the CALLER's OWN thread id (`AgentConfig.sessionId` /
   *  the bootstrapped session id). The `@thread:` resolver + enumerator scope
   *  to this thread's lineage (self ∪ ancestors ∪ descendants over the fork
   *  chain). ABSENT ⇒ FAIL-CLOSED: the lineage set is empty ⇒ NO `@thread:` id
   *  resolves and NO thread is enumerated (a strict subset, never a widening). */
  readonly selfThreadId?: string
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

const threadIndex = (all: readonly ThreadSummary[]): ReadonlyMap<string, ThreadSummary> =>
  new Map(
    all
      .filter((thread) => typeof thread?.id === "string" && thread.id.length > 0)
      .map((thread) => [thread.id, thread]),
  )

const descendantIdsOf = (all: readonly ThreadSummary[], selfId: string): ReadonlySet<string> => {
  const descendants = new Set<string>([selfId])
  let grew = true
  while (grew) {
    grew = false
    for (const thread of all) {
      const parent = thread.forkedFromId
      if (
        typeof thread?.id === "string" &&
        thread.id.length > 0 &&
        !descendants.has(thread.id) &&
        typeof parent === "string" &&
        descendants.has(parent)
      ) {
        descendants.add(thread.id)
        grew = true
      }
    }
  }
  return descendants
}

const ancestorIdsOf = (
  byId: ReadonlyMap<string, ThreadSummary>,
  selfId: string,
): ReadonlySet<string> => {
  const ancestors = new Set<string>()
  const seen = new Set<string>([selfId])
  let cursor = byId.get(selfId)?.forkedFromId
  while (typeof cursor === "string" && cursor.length > 0 && !seen.has(cursor)) {
    seen.add(cursor)
    if (byId.has(cursor)) ancestors.add(cursor)
    cursor = byId.get(cursor)?.forkedFromId
  }
  return ancestors
}

/**
 * B4 lineage scope — compute the set of thread ids inside the caller's lineage
 * over the `forkedFromId` fork chain: `self ∪ transitive-ancestors ∪
 * transitive-descendants`. Pure; no IO.
 *
 * FAIL-CLOSED: an absent / empty `selfId`, or a `selfId` that names no thread in
 * the list, yields the EMPTY set (the caller is unknown ⇒ nothing is in-scope).
 * The walk is cycle-safe (a `visited`/`seen` guard) so a corrupt self-referential
 * or looped fork chain terminates instead of spinning.
 *
 *   - ANCESTORS: follow `forkedFromId` upward from self until it is absent or
 *     dangling (the parent may have been deleted — provenance, not a live ptr).
 *   - DESCENDANTS: fixpoint over "any thread whose `forkedFromId` is already in
 *     the in-scope set" — this captures the WHOLE subtree, not just direct
 *     children, and stays sibling-tight (a sibling's parent is the caller's
 *     parent, never the caller or a descendant, so it is never admitted).
 */
export const computeLineageIds = (
  all: readonly ThreadSummary[],
  selfId: string | undefined,
): ReadonlySet<string> => {
  const scope = new Set<string>()
  if (typeof selfId !== "string" || selfId.length === 0) return scope // fail-closed
  const byId = threadIndex(all)
  if (!byId.has(selfId)) return scope // self not in the list ⇒ unknown caller ⇒ empty
  // Descendants FIRST, seeded by SELF ONLY (never by ancestors — else the
  // fixpoint would walk DOWN from a shared ancestor into a SIBLING's subtree,
  // which is exactly the leak this gate closes). A `descendants` set separate
  // from `scope` keeps the seed clean; fixpoint admits any thread whose parent
  // is already a known descendant (or self).
  for (const descendant of descendantIdsOf(all, selfId)) scope.add(descendant)
  // Ancestors: walk the parent chain upward from SELF (cycle-safe). Ancestors are
  // added to `scope` but NOT to the descendant seed, so their OTHER children
  // (the caller's siblings) are never swept in.
  for (const ancestor of ancestorIdsOf(byId, selfId)) scope.add(ancestor)
  return scope
}

/** Project the live session list into a `ThreadSummaryPort`: `id → summary`, or
 *  `null` for an unknown id. Reads the list once per lookup (the session store's
 *  own IO); a load fault ⇒ every id resolves `null` (NO-THROW).
 *
 *  B4 LINEAGE GATE (load-bearing): the summary is returned ONLY when `id` is in
 *  the caller's lineage set (see {@link computeLineageIds}). An out-of-lineage id
 *  — a SIBLING or unrelated thread — resolves `null`, exactly as an unknown id
 *  would (no oracle: refused and absent are indistinguishable to the caller).
 *  FAIL-CLOSED on an absent `selfThreadId` (empty scope ⇒ every id null). */
const threadSummaryFor = (
  sessions: SessionListSource,
  selfThreadId: string | undefined,
): NonNullable<BuildDefaultMentionResolverOptions["threadSummary"]> => {
  return async (id: string) => {
    if (typeof id !== "string" || id.length === 0) return null
    try {
      const all = await sessions()
      const scope = computeLineageIds(all, selfThreadId)
      if (!scope.has(id)) return null // out-of-lineage (sibling/unrelated) ⇒ refused
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
      ? { threadSummary: threadSummaryFor(sources.sessions, sources.selfThreadId) }
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

/** Capture the async session source exactly once for the synchronous provider.
 * A failed read deliberately becomes an empty, lineage-scoped snapshot. */
const threadListerFor = async (
  sessions: SessionListSource,
  selfThreadId: string | undefined,
): Promise<() => readonly NamedEntry[]> => {
  let snapshot: readonly ThreadSummary[] = []
  try {
    snapshot = await sessions()
  } catch {
    snapshot = []
  }
  const scope = computeLineageIds(snapshot, selfThreadId)
  const entries = listThreadsFrom(snapshot.filter((thread) => scope.has(thread.id)))
  return () => entries
}

const providerMcpLister = (
  sources: MentionLiveSources,
  env: MentionSourceEnv,
): (() => readonly NamedEntry[]) | undefined =>
  isOn(env, "QUANTA_MENTION_MCP") &&
  sources.mcpServers !== undefined &&
  sources.mcpServers.length > 0
    ? listMcpFor(sources.mcpServers)
    : undefined

const providerSubagentLister = (
  sources: MentionLiveSources,
  env: MentionSourceEnv,
): (() => readonly NamedEntry[]) | undefined =>
  isOn(env, "QUANTA_MENTION_SUBAGENT") && sources.subagents !== undefined
    ? listSubagentsFor(sources.subagents)
    : undefined

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
  const listMcpServers = providerMcpLister(sources, env)
  const listSubagents = providerSubagentLister(sources, env)
  const listThreads =
    isOn(env, "QUANTA_MENTION_THREAD") && sources.sessions !== undefined
      ? await threadListerFor(sources.sessions, sources.selfThreadId)
      : undefined
  return {
    ...(listMcpServers !== undefined ? { listMcpServers } : {}),
    ...(listSubagents !== undefined ? { listSubagents } : {}),
    ...(listThreads !== undefined ? { listThreads } : {}),
  }
}
