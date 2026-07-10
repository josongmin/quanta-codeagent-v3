/**
 * `@/apps/web-daemon/readout` — read-only "slash readouts" served OUT-OF-BAND
 * over an HTTP route (`GET /readout/:name`), NOT the WS turn channel.
 *
 * # Why out-of-band (the load-bearing architectural decision)
 * An in-flight `turn.run` holds the session single-writer lease for its entire
 * duration; any other WS command routed through `lease.runWith` throws
 * `single_writer_lease_held`. So a `/state` readout fired *while the agent is
 * working* — exactly when you want to look — would be REJECTED on the WS
 * channel. The daemon already serves knobs this way; this mirrors it: the
 * route reads the live `RuntimeSession.snapshot()` (a JS-single-thread sync
 * read between the turn's await-points ⇒ no torn read, no lease) and responds
 * per-client. Works idle AND mid-turn.
 *
 * # Slice fence
 * `renderReadout` stays PURE (snapshot in, text out). `resolveReadout` adds the
 * SOURCE-BACKED readouts (UUX-1-11): it awaits narrow read-accessor closures
 * ({@link WebReadoutSources}) injected by the composition root — never reaching
 * into `@/apps/cli` (the biome fence forbids the daemon from touching the CLI
 * registry) and never mutating the host. TOTAL: a throwing / rejecting accessor
 * degrades to a graceful payload — the route can never 500 on a readout.
 *
 * # Coverage (UUX-1-11)
 * Snapshot-served: `/state`, `/capabilities`. Source-backed (live once the
 * composition root threads the accessor): `/agents` (subagent TaskRegistry),
 * `/plan` (session plan store), `/skills` (disk discovery), `/memory`
 * (durable store, read-only), `/cost` (server-side turn-usage fold), `/context`
 * (onPromptAssembled usage holder). SKIPPED with honest copy naming what is
 * missing on THIS surface: `/mcp` (the daemon composes no MCP bridge), `/why`
 * (needs the session JSONL recorder + a one-shot LLM meta-query — this channel
 * is read-only and makes no LLM calls), `/branches` (branch_search is not
 * composed on the web surface).
 */
import type { ContextUsageBreakdown } from "@/agent/context/usage-breakdown"
import { errMessage } from "@/shared"
import type { Plan, TodoItem } from "@/agent/plan/types"
import type { CapabilityManifest, SessionSnapshotLite, SessionStateView } from "@/protocol/session"

export interface ReadoutResult {
  /** Normalized command name (alias-resolved, e.g. `caps` → `capabilities`). */
  readonly name: string
  /** Rendered, ANSI-free text body for the web to display. Always non-empty. */
  readonly output: string
  /** True only for an UNKNOWN readout name. A recognized-but-pending readout is
   *  NOT an error — it is a graceful "not wired here yet". */
  readonly isError: boolean
  /** True when this surface actually served live data; false when the name is
   *  recognized but its host accessor is not on the snapshot yet (pending), or
   *  the name is unknown. The web can badge "pending" distinctly from a crash. */
  readonly wired: boolean
}

/* ------------------------------------------------------------------ */
/* UUX-1-11 — source-backed readout seams                               */
/* ------------------------------------------------------------------ */

/** Narrow structural view over one subagent `TaskRecord` (the daemon maps the
 *  registry record; the readout renderer never imports `@/subagent`). */
export interface AgentFleetReadoutRow {
  readonly id: string
  readonly description: string
  readonly agentType?: string
  readonly status: "running" | "completed" | "failed" | "stopped"
  readonly startedAt: number
  readonly endedAt?: number
  readonly error?: string
}

/** Narrow view over one durable memory entry (id + tier + text + weight). */
export interface MemoryReadoutEntry {
  readonly id: string
  readonly tier?: string
  readonly text: string
  readonly importance?: number
  readonly createdAt: number
}

/** Cumulative session usage folded server-side from `turn.completed` events. */
export interface CostReadoutTotals {
  readonly turns: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
  readonly costMicroUsd: number
  readonly modelSlug?: string
}

/**
 * The read-accessor bundle the composition root threads to the readout route.
 * Every field is OPTIONAL and READ-ONLY: an absent accessor degrades that one
 * readout to an honest "here is what is missing" line; a present accessor is
 * awaited inside a try/catch so a host-side throw can never 500 the daemon.
 */
export interface WebReadoutSources {
  /** Subagent fleet rows (live TaskRegistry projection). */
  readonly agents?: () => readonly AgentFleetReadoutRow[]
  /** Current session plan (or null before the agent creates one). */
  readonly plan?: () => Plan | null
  /** Fresh skills discovery (user dir + bundled system skills). */
  readonly skills?: () => Promise<readonly { name: string; description: string }[]>
  /** Recent durable memory entries, newest first (read-only store view). */
  readonly memory?: () => Promise<readonly MemoryReadoutEntry[]>
  /** Cumulative session usage totals. */
  readonly cost?: () => CostReadoutTotals
  /** Latest segmented context-usage breakdown (undefined before turn 1). */
  readonly context?: () => ContextUsageBreakdown | undefined
  /** Injectable clock for deterministic age rendering under test. */
  readonly now?: () => number
}

/** Source-backed readout names: recognized, and served LIVE whenever the
 *  composition root threads the matching {@link WebReadoutSources} accessor.
 *  Absent accessor ⇒ graceful wired:false line NAMING the missing piece. */
export const SOURCE_BACKED_READOUTS = [
  "agents",
  "plan",
  "skills",
  "memory",
  "cost",
  "context",
] as const

/** Readouts this surface deliberately does NOT serve, with the honest reason
 *  (UUX-1-11: the copy must name WHAT is missing, not just "not wired"). */
const SKIPPED_READOUT_COPY: Readonly<Record<string, string>> = {
  mcp:
    "/mcp: no MCP bridge on the web surface — MCP servers are launched by the " +
    "CLI composition root; this daemon composes no MCP clients, so there is no " +
    "server health to report",
  why:
    "/why: needs the recorded session JSONL plus a one-shot LLM meta-query " +
    "(the CLI why-command); this read-only readout channel records no session " +
    "JSONL and makes no LLM calls",
  branches:
    "/branches: branch_search is not composed on the web surface " +
    "(AgentConfig.branchSearch absent — no N-best leaderboard state exists here)",
}

export const SKIPPED_READOUTS: readonly string[] = Object.keys(SKIPPED_READOUT_COPY)

/** Copy for a source-backed readout whose accessor is absent at runtime —
 *  names the exact missing composition piece (never a bare "not wired"). */
const MISSING_SOURCE_COPY: Readonly<Record<(typeof SOURCE_BACKED_READOUTS)[number], string>> = {
  agents:
    "/agents: subagent task registry not composed on this daemon " +
    "(runtime-factory readout sources absent)",
  plan: "/plan: plan store not composed on this daemon (runtime-factory readout sources absent)",
  skills:
    "/skills: skills discovery not composed on this daemon " +
    "(skills config absent or readout sources not threaded)",
  memory:
    "/memory: durable memory store unavailable on this daemon " +
    "(QUANTA_MEMORY=off, or the readout store handle was not composed)",
  cost: "/cost: usage aggregator not attached (the server-side turn-usage fold is absent)",
  context:
    "/context: context-usage holder not composed " +
    "(the onPromptAssembled seam was not threaded on this daemon)",
}

const yesno = (b: boolean): string => (b ? "yes" : "no")

const renderCapabilities = (m: CapabilityManifest): string =>
  [
    "capabilities",
    `  transport       ${m.transport}`,
    `  approvals       ${m.approvals}`,
    `  tools           ${yesno(m.tools)}`,
    `  subagents       ${yesno(m.subagents)}`,
    `  memory          ${yesno(m.memory)}`,
    `  artifacts       ${yesno(m.artifacts)}`,
    `  automation      ${yesno(m.automation)}`,
    `  shell snapshot  ${yesno(m.shellSnapshot)}`,
  ].join("\n")

const renderState = (s: SessionStateView): string => {
  const lines = [
    "session state",
    `  status        ${s.status}`,
    `  permission    ${s.permissionMode}`,
  ]
  if (s.identityMode !== undefined) lines.push(`  identity      ${s.identityMode}`)
  if (s.toolProfile !== undefined) lines.push(`  tool profile  ${s.toolProfile}`)
  if (s.modelSlug !== undefined) lines.push(`  model         ${s.modelSlug}`)
  lines.push(`  messages      ${s.messageCount}`)
  if (s.lastOutcomeReason !== undefined) lines.push(`  last outcome  ${s.lastOutcomeReason}`)
  return lines.join("\n")
}

/* ------------------------------------------------------------------ */
/* UUX-1-11 — pure renderers for the source-backed readouts            */
/* ------------------------------------------------------------------ */

const firstLine = (s: string): string => s.split("\n")[0] ?? ""

const clampLine = (s: string, max = 120): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`

const renderAge = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "-"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

const renderAgents = (rows: readonly AgentFleetReadoutRow[], now: number): string => {
  if (rows.length === 0) return "agents: no subagent tasks yet (fleet idle)"
  // Running first, then settled by recency (mirrors the CLI fleet panel order).
  const running = rows.filter((r) => r.status === "running")
  const settled = rows
    .filter((r) => r.status !== "running")
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const lines = [`agents — ${running.length} running / ${settled.length} settled`]
  for (const r of [...running, ...settled]) {
    const type = r.agentType !== undefined ? ` [${r.agentType}]` : ""
    const age = renderAge(now - r.startedAt)
    const err = r.error !== undefined ? ` — ${clampLine(firstLine(r.error), 80)}` : ""
    lines.push(
      `  ${r.id}  ${r.status}${type}  ${age}  ${clampLine(firstLine(r.description), 80)}${err}`,
    )
  }
  return lines.join("\n")
}

const TODO_GLYPH: Readonly<Record<TodoItem["status"], string>> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
  blocked: "[!]",
}

const renderPlan = (plan: Plan | null): string => {
  if (plan === null) return "plan: no plan yet (the agent has not created one this session)"
  const todos = Object.values(plan.todos)
  const done = todos.filter((t) => t.status === "completed").length
  const lines = [
    `plan: ${plan.name} (v${plan.version}, ${done}/${todos.length} done)`,
    ...(plan.overview.length > 0 ? [`  ${clampLine(firstLine(plan.overview))}`] : []),
  ]
  for (const t of todos) {
    lines.push(`  ${TODO_GLYPH[t.status]} ${clampLine(firstLine(t.content))} (${t.status})`)
  }
  return lines.join("\n")
}

const renderSkillsRows = (rows: readonly { name: string; description: string }[]): string => {
  if (rows.length === 0) return "skills: 0 skills discovered"
  const lines = [`skills: ${rows.length} skill${rows.length === 1 ? "" : "s"} discovered`]
  for (const r of [...rows].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    lines.push(`  ${r.name.padEnd(24)} ${clampLine(firstLine(r.description), 100)}`)
  }
  return lines.join("\n")
}

const MEMORY_RECENT_MAX = 10

const renderMemory = (entries: readonly MemoryReadoutEntry[]): string => {
  if (entries.length === 0) return "memory: store is empty (no memories recorded yet)"
  const perTier = new Map<string, number>()
  for (const e of entries) {
    const tier = e.tier ?? "semantic"
    perTier.set(tier, (perTier.get(tier) ?? 0) + 1)
  }
  const tierSummary = [...perTier.entries()].map(([t, n]) => `${t} ${n}`).join(", ")
  const recent = [...entries].sort((a, b) => b.createdAt - a.createdAt).slice(0, MEMORY_RECENT_MAX)
  const lines = [
    `memory: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (${tierSummary}) — read-only view; this surface does not write memories`,
  ]
  for (const e of recent) {
    const imp = e.importance !== undefined ? ` ·${e.importance.toFixed(2)}` : ""
    lines.push(`  ${e.id}  [${e.tier ?? "semantic"}${imp}]  ${clampLine(firstLine(e.text), 90)}`)
  }
  return lines.join("\n")
}

const renderCost = (t: CostReadoutTotals): string => {
  const lines = [
    "session cost (cumulative)",
    `  turns              ${t.turns}`,
    `  prompt tokens      ${t.promptTokens}`,
    `  completion tokens  ${t.completionTokens}`,
    `  total tokens       ${t.totalTokens}`,
  ]
  if (t.costMicroUsd > 0)
    lines.push(`  est. cost          $${(t.costMicroUsd / 1_000_000).toFixed(4)}`)
  if (t.modelSlug !== undefined) lines.push(`  model              ${t.modelSlug}`)
  if (t.turns === 0) lines.push("  (no completed turns yet)")
  return lines.join("\n")
}

const renderContext = (view: ContextUsageBreakdown | undefined): string => {
  if (view === undefined) {
    return "context: no prompt assembled yet (per-turn usage not available)"
  }
  const header =
    view.max > 0
      ? `context: ${view.total} / ${view.max} tokens${view.model !== undefined ? ` (${view.model})` : ""}`
      : `context: ${view.total} tokens${view.model !== undefined ? ` (${view.model})` : ""}`
  const lines = [header]
  for (const seg of view.segments) {
    const pct = view.total > 0 ? ` (${Math.round((seg.tokens / view.total) * 100)}%)` : ""
    lines.push(`  ${String(seg.id).padEnd(14)} ${seg.tokens}${pct}`)
  }
  return lines.join("\n")
}

/**
 * Render a read-only readout from the live session snapshot. Pure + total —
 * NEVER throws (a malformed/partial snapshot still yields a result), so the
 * route can't 500 on bad input. Unknown name ⇒ isError; recognized-but-
 * source-absent ⇒ graceful line naming what is missing; served ⇒ live text.
 * Source-backed rendering happens in {@link resolveReadout}; this pure form is
 * the sources-absent projection of the same contract.
 */
export const renderReadout = (name: string, snapshot: SessionSnapshotLite): ReadoutResult => {
  const n = name.trim().toLowerCase()
  if (n === "capabilities" || n === "caps") {
    return {
      name: "capabilities",
      output: renderCapabilities(snapshot.capabilities),
      isError: false,
      wired: true,
    }
  }
  if (n === "state") {
    return { name: "state", output: renderState(snapshot.state), isError: false, wired: true }
  }
  const skipped = SKIPPED_READOUT_COPY[n]
  if (skipped !== undefined) {
    return { name: n, output: skipped, isError: false, wired: false }
  }
  if ((SOURCE_BACKED_READOUTS as readonly string[]).includes(n)) {
    return {
      name: n,
      output: MISSING_SOURCE_COPY[n as (typeof SOURCE_BACKED_READOUTS)[number]],
      isError: false,
      wired: false,
    }
  }
  return { name: n, output: `unknown readout: ${n || "(empty)"}`, isError: true, wired: false }
}

const served = (name: string, output: string): ReadoutResult => ({
  name,
  output,
  isError: false,
  wired: true,
})

const sourceFailed = (name: string, error: unknown): ReadoutResult => ({
  name,
  output: `/${name}: readout source failed: ${errMessage(error)}`,
  isError: false, // graceful — the route answers 200, never 500
  wired: false,
})

/**
 * Resolve a readout against the live snapshot PLUS the composition root's
 * {@link WebReadoutSources}. TOTAL: never rejects — an accessor that throws
 * (sync or async) degrades to a graceful `wired:false` payload carrying the
 * error message, so the HTTP route can never 500 on a readout.
 */
export const resolveReadout = async (
  name: string,
  snapshot: SessionSnapshotLite,
  sources: WebReadoutSources,
): Promise<ReadoutResult> => {
  const n = name.trim().toLowerCase()
  try {
    switch (n) {
      case "agents":
        if (sources.agents === undefined) break
        return served(n, renderAgents(sources.agents(), sources.now?.() ?? Date.now()))
      case "plan":
        if (sources.plan === undefined) break
        return served(n, renderPlan(sources.plan()))
      case "skills":
        if (sources.skills === undefined) break
        return served(n, renderSkillsRows(await sources.skills()))
      case "memory":
        if (sources.memory === undefined) break
        return served(n, renderMemory(await sources.memory()))
      case "cost":
        if (sources.cost === undefined) break
        return served(n, renderCost(sources.cost()))
      case "context":
        if (sources.context === undefined) break
        return served(n, renderContext(sources.context()))
      default:
        break
    }
  } catch (error) {
    return sourceFailed(n, error)
  }
  // Source absent / snapshot-served / skipped / unknown — the pure renderer
  // already answers all of those totally.
  return renderReadout(name, snapshot)
}

/** The names that serve LIVE data from the snapshot alone (source-backed names
 *  additionally serve live data whenever their accessor is composed). Exported
 *  so the web palette + a ratchet can enumerate the always-live set. */
export const SERVED_READOUTS: readonly string[] = ["state", "capabilities", "caps"]
