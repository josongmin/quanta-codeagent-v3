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
 * (durable store, read-only), `/cost` (canonical usage-authority projection), `/context`
 * (onPromptAssembled usage holder), `/doctor` (store-health report), `/mcp` (the
 * live MCP server rows, once the root threads the accessor — this list was stale:
 * `/mcp` moved from SKIPPED to source-backed and the docblock kept saying "the
 * daemon composes no MCP bridge"), `/model` (the sticky-model store + provider
 * catalog behind `set_model`). SKIPPED with honest copy naming what is missing on
 * THIS surface: `/why` (needs the session JSONL recorder + a one-shot LLM
 * meta-query — this channel is read-only and makes no LLM calls), `/branches`
 * (branch_search is not composed on the web surface).
 *
 * The three lists below are the SSOT for that vocabulary in both directions: the
 * browser palette must offer exactly their union (guarded by
 * `tests/unit/apps/web-daemon/readout-slug-parity-hellgate.test.ts`), which is why
 * this prose can only ever be a summary of them — trust the tuples, not the text.
 */
import type { ContextUsageBreakdown } from "@/agent/context/usage-breakdown"
import type { Plan, TodoItem } from "@/agent/plan/types"
import type { ObjectiveDomainSnapshot } from "@/objective"
import type {
  CapabilityManifest,
  CostSurfaceViewWire,
  SessionSnapshotLite,
  SessionStateView,
} from "@/protocol/session"
import type { StoreHealthReport } from "@/session"
import { errMessage, type ThinClientRoute } from "@/shared"
import { sanitizeModelDisplayLabel } from "@/shared/model-display"
import { renderWebModelReadout } from "./web-model-switch"

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
export type CostReadoutTotals = { readonly turns: number } & CostSurfaceViewWire

/**
 * The read-accessor bundle the composition root threads to the readout route.
 * Every field is OPTIONAL and READ-ONLY: an absent accessor degrades that one
 * readout to an honest "here is what is missing" line; a present accessor is
 * awaited inside a try/catch so a host-side throw can never 500 the daemon.
 */
/** P4 — one MCP server's live row for the `/mcp` readout. */
export interface McpServerRow {
  readonly name: string
  readonly status: "up" | "down"
  readonly toolCount?: number
  readonly reason?: string
}

export interface WebReadoutSources {
  /** Subagent fleet rows (live TaskRegistry projection). */
  readonly agents?: () => readonly AgentFleetReadoutRow[]
  /** Current session plan (or null before the agent creates one). */
  readonly plan?: () => Plan | null
  /** Fresh skills discovery (user dir + bundled system skills). `route` (ADR-0493,
   *  G2b-01 wire) is the RESOLVED thin-client route for this surface — present only
   *  when it routes away from "local" (gate ON + a tagged skill). */
  readonly skills?: () => Promise<
    readonly { name: string; description: string; route?: ThinClientRoute }[]
  >
  /** Recent durable memory entries, newest first (read-only store view). */
  readonly memory?: () => Promise<readonly MemoryReadoutEntry[]>
  /** Cumulative session usage totals. */
  readonly cost?: () => CostReadoutTotals
  /** Latest segmented context-usage breakdown (undefined before turn 1). */
  readonly context?: () => ContextUsageBreakdown | undefined
  /** P4/P2 (jul-11, UUX-4-18) — session-store health probe (the CLI's
   *  `checkSessionStoreHealth`, dependency-free async). The `/doctor` readout
   *  renders its verdict + counts + recovery guidance. Absent ⇒ honest
   *  missing-source line. */
  readonly doctor?: () => Promise<StoreHealthReport>
  /** P4 (jul-11, UUX-4-14) — live MCP server list + health, now that the daemon
   *  composes MCP from @/host/mcp-composition. Absent ⇒ honest missing line. */
  readonly mcp?: () => readonly McpServerRow[]
  /** aug-27 — the model READ half of the web model switch: the effective model
   *  (persisted pick, else boot) + every candidate the daemon can swap to. The
   *  accessor AWAITS the provider-catalog probe, so opening this readout is what
   *  populates the list (the daemon pays no boot-time network call). The WRITE
   *  half is the `controlRequest` `set_model` frame. Absent ⇒ honest missing line. */
  readonly model?: () => Promise<{ readonly current: string; readonly ids: readonly string[] }>
  /** W1b — the objective DOMAIN snapshot for this daemon's session. The DOMAIN,
   *  not the projected `Objective`: `revision`, the validation contract and the
   *  progress receipts live on the snapshot and are exactly what a person needs
   *  to answer "what is this goal doing" — none of them ride the observability
   *  objective frame. Bound to the LIVE session id by the composition root.
   *  Absent ⇒ honest missing-source line. */
  readonly goal?: () => ObjectiveDomainSnapshot
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
  "doctor",
  "mcp",
  "model",
  "goal",
] as const

/** Readouts this surface deliberately does NOT serve, with the honest reason
 *  (UUX-1-11: the copy must name WHAT is missing, not just "not wired"). */
const SKIPPED_READOUT_COPY: Readonly<Record<string, string>> = {
  why:
    "/why: needs the recorded session JSONL plus a one-shot LLM meta-query " +
    "(the CLI why-command); this read-only readout channel records no session " +
    "JSONL and makes no LLM calls",
  branches:
    "/branches: branch_search is not composed on the web surface " +
    "(AgentConfig.branchSearch absent — no N-best leaderboard state exists here)",
}

export const SKIPPED_READOUTS: readonly string[] = Object.keys(SKIPPED_READOUT_COPY)

/** The readouts served straight from the session SNAPSHOT (no injected accessor).
 *  Explicit (aug-28) because it is the third leg of this surface's readout
 *  vocabulary — the browser palette must offer exactly
 *  `SOURCE_BACKED ∪ SNAPSHOT_SERVED ∪ SKIPPED`, and a hand-copied literal in the
 *  frontend had already drifted. Load-bearing, not decorative: {@link renderReadout}
 *  dispatches through {@link SNAPSHOT_RENDERERS}, whose `Record` over this tuple is
 *  compile-time exhaustive. */
export const SNAPSHOT_SERVED_READOUTS = ["state", "capabilities"] as const

/** Aliases the route accepts for a canonical readout name. */
export const READOUT_ALIASES: Readonly<Record<string, string>> = { caps: "capabilities" }

const age = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - at) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`
}

/** W1b — the goal, rendered from the DOMAIN snapshot. Deliberately not shared
 *  with the CLI's `renderGoalDomain`: the biome slice fence forbids this daemon
 *  from importing `@/apps/cli`, and the two surfaces answer different questions
 *  (the CLI line sits under an interactive prompt; this is a standalone page a
 *  person opens mid-turn). */
export const renderGoalReadout = (domain: ObjectiveDomainSnapshot, now: number): string => {
  const objective = domain.state?.objective
  if (objective === undefined) {
    return (
      "No goal is set for this session.\n" +
      "Ask the agent to set one, or run `/goal <objective>` from the quanta CLI.\n"
    )
  }
  const criteria = objective.successCriteria
  const met = criteria.filter((criterion) => criterion.met).length
  const remaining = criteria.filter((criterion) => !criterion.met).map((c) => c.text)
  const budget = objective.budget
  const last = domain.progressReceipts?.at(-1)
  const started = objective.attempts.started
  const blockers = objective.blockers
    .slice(0, 3)
    .map((blocker) => `  - [${blocker.waitingOn}] ${blocker.reason}`)
  return (
    // ONE line, always: a goal may contain newlines, and a wrapped goal would put
    // arbitrary operator text where the next field belongs — which is how a
    // reader ends up parsing a criterion as the status.
    `goal   ${objective.goal.replace(/\s+/g, " ").trim()}\n` +
    `status ${objective.status} · rev ${domain.revision} · validation ${domain.validationContract}\n` +
    `criteria ${met}/${criteria.length} met` +
    (remaining.length === 0 ? "\n" : `   remaining: ${remaining.join(", ")}\n`) +
    `budget ${budget.turnsUsed}/${budget.maxTurns ?? "\u221e"} turns · ` +
    `${budget.tokensUsed}/${budget.maxTokens ?? "\u221e"} tokens` +
    (budget.limitedBy === undefined ? "\n" : ` · limited by: ${budget.limitedBy}\n`) +
    (last === undefined
      ? "last attempt: none\n"
      : `last attempt: ${last.turnOutcome} · ${age(last.recordedAt, now)} · rev ${last.objectiveRevisionAfter}\n`) +
    // The RUNNING attempt, not just the last settled one. Without it `/goal
    // abandon` has no observable end state, and an operator whose `edit` was
    // refused `attempt-in-flight` has no way to see why.
    (started === undefined ? "" : `attempt: running ${started.attemptId}\n`) +
    (blockers.length === 0 ? "" : `blockers:\n${blockers.join("\n")}\n`) +
    (objective.nextActions.length === 0 ? "" : `next: ${objective.nextActions[0]}\n`)
  )
}

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
  cost: "/cost: canonical usage-accounting projection is not attached",
  context:
    "/context: context-usage holder not composed " +
    "(the onPromptAssembled seam was not threaded on this daemon)",
  doctor:
    "/doctor: session-store health probe not composed " +
    "(the doctor accessor was not threaded on this daemon)",
  model:
    "/model: the model switch was not composed on this daemon " +
    "(no sticky-model store + candidate catalog were threaded, so there is " +
    "nothing to list and set_model would not land)",
  mcp:
    "/mcp: no MCP servers configured for this daemon " +
    "(no .mcp.json entries, or the mcp accessor was not threaded)",
  goal:
    "/goal: no objective authority is composed on this daemon " +
    "(QUANTA_OBJECTIVE_TOOLS is off, so there is no goal domain to read)",
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

const renderSkillsRows = (
  rows: readonly { name: string; description: string; route?: ThinClientRoute }[],
): string => {
  if (rows.length === 0) return "skills: 0 skills discovered"
  const lines = [`skills: ${rows.length} skill${rows.length === 1 ? "" : "s"} discovered`]
  for (const r of [...rows].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    // ADR-0493 — annotate the resolved thin-client route ONLY when it routes
    // away from local (the producer omits "local"), so the default rendering is
    // byte-identical when the gate is off or the skill carries no tag.
    const route = r.route !== undefined ? `  [thin-client: ${r.route}]` : ""
    lines.push(`  ${r.name.padEnd(24)} ${clampLine(firstLine(r.description), 100)}${route}`)
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
  if (t.status === "off") {
    return ["session cost", `  turns              ${t.turns}`, "  accounting         off"].join(
      "\n",
    )
  }
  const totalTokens = t.promptTokens + t.outputTokens
  const lines = [
    "session cost (cumulative)",
    `  turns              ${t.turns}`,
    `  prompt tokens      ${t.promptTokens}`,
    `  completion tokens  ${t.outputTokens}`,
    `  total tokens       ${totalTokens}`,
  ]
  if (t.continuityLost)
    lines.push("  continuity         prior totals lost; current total is partial")
  if (t.totalUsd > 0) {
    lines.push(`  cost               $${t.totalUsd.toFixed(4)}`)
  } else if (t.unpricedCalls > 0) {
    lines.push("  cost               incomplete")
  }
  if (t.estimatedUsd > 0) lines.push(`  estimated portion  $${t.estimatedUsd.toFixed(4)}`)
  if (t.unpricedCalls > 0) lines.push(`  unpriced calls     ${t.unpricedCalls}`)
  if (t.subagentUsd > 0) {
    lines.push(`  root / subagents   $${t.rootUsd.toFixed(4)} / $${t.subagentUsd.toFixed(4)}`)
  }
  if (t.modelSlug !== undefined)
    lines.push(`  model              ${sanitizeModelDisplayLabel(t.modelSlug)}`)
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
/** The snapshot-served renderers, keyed by {@link SNAPSHOT_SERVED_READOUTS}. A full
 *  `Record` over the tuple, so adding a name to that list without a renderer here
 *  is a COMPILE error (same drift-guard shape as {@link LIVE_READOUTS}). */
const SNAPSHOT_RENDERERS: Readonly<
  Record<(typeof SNAPSHOT_SERVED_READOUTS)[number], (s: SessionSnapshotLite) => string>
> = {
  state: (s) => renderState(s.state),
  capabilities: (s) => renderCapabilities(s.capabilities),
}

export const renderReadout = (name: string, snapshot: SessionSnapshotLite): ReadoutResult => {
  const raw = name.trim().toLowerCase()
  const n = READOUT_ALIASES[raw] ?? raw
  const snapshotRenderer = (
    SNAPSHOT_RENDERERS as Record<string, ((s: SessionSnapshotLite) => string) | undefined>
  )[n]
  if (snapshotRenderer !== undefined) {
    return { name: n, output: snapshotRenderer(snapshot), isError: false, wired: true }
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
/** P4/P2 (jul-11) — render a session-store health report as a readout body:
 *  verdict headline + counts + recovery guidance when non-healthy. */
const renderDoctor = (report: StoreHealthReport): string => {
  const head = `session store: ${report.verdict} (${report.ok}/${report.total} ok, ${report.corrupt} corrupt, ${report.unreadable} unreadable)`
  const root = `root: ${report.root}`
  return report.guidance !== undefined ? `${head}\n${root}\n${report.guidance}` : `${head}\n${root}`
}

/** P4 (jul-11) — render live MCP server rows: name + up/down + tool count /
 *  down reason. Empty ⇒ an honest "no servers connected" line. */
const renderMcp = (rows: readonly McpServerRow[]): string => {
  if (rows.length === 0) return "mcp: no servers connected"
  return rows
    .map((r) => {
      const suffix =
        r.status === "up"
          ? ` (${r.toolCount ?? 0} tool${r.toolCount === 1 ? "" : "s"})`
          : r.reason !== undefined
            ? ` — ${r.reason}`
            : ""
      return `${r.status === "up" ? "✓ up" : "✗ down"} ${r.name}${suffix}`
    })
    .join("\n")
}

/** One row of the dispatch table below: given the composed accessor bundle,
 *  render this readout's body — or `undefined` when its accessor is ABSENT, in
 *  which case the caller falls through to the pure renderer's honest
 *  missing-source copy. Returning a promise is allowed (and only the genuinely
 *  async accessors do), so the sync rows stay sync exactly as they were. */
type LiveReadoutRow = (sources: WebReadoutSources) => string | Promise<string> | undefined

/** `render(await value)` as one expression, so an ASYNC accessor can live in
 *  the table without making its row an `async` arrow — an `async` row would
 *  turn the ABSENT case (`undefined`) into a promise too, adding a microtask
 *  the original `break` never paid. */
const mapAwaited = async <T>(value: Promise<T>, render: (v: T) => string): Promise<string> =>
  render(await value)

/**
 * The source-backed dispatch TABLE.
 *
 * This replaces an eight-arm `switch` in which every arm spelled the SAME two
 * steps — "is the accessor composed? if not `break`; else render its value" —
 * and every repetition paid an `if` nested inside a `switch` inside a `try`.
 * One row per name kills the repetition; the `Record` over
 * {@link SOURCE_BACKED_READOUTS} makes the correspondence EXHAUSTIVE, so a name
 * added to that list without a row here is a TYPE error rather than a silently
 * unserved readout.
 */
const LIVE_READOUTS: Readonly<Record<(typeof SOURCE_BACKED_READOUTS)[number], LiveReadoutRow>> = {
  agents: (s) =>
    s.agents === undefined ? undefined : renderAgents(s.agents(), s.now?.() ?? Date.now()),
  plan: (s) => (s.plan === undefined ? undefined : renderPlan(s.plan())),
  skills: (s) => (s.skills === undefined ? undefined : mapAwaited(s.skills(), renderSkillsRows)),
  memory: (s) => (s.memory === undefined ? undefined : mapAwaited(s.memory(), renderMemory)),
  cost: (s) => (s.cost === undefined ? undefined : renderCost(s.cost())),
  context: (s) => (s.context === undefined ? undefined : renderContext(s.context())),
  doctor: (s) => (s.doctor === undefined ? undefined : mapAwaited(s.doctor(), renderDoctor)),
  mcp: (s) => (s.mcp === undefined ? undefined : renderMcp(s.mcp())),
  model: (s) => (s.model === undefined ? undefined : mapAwaited(s.model(), renderWebModelReadout)),
  goal: (s) =>
    s.goal === undefined ? undefined : renderGoalReadout(s.goal(), s.now?.() ?? Date.now()),
}

/** Narrow an arbitrary readout name onto the table. A unit because it is the
 *  one place the `string` → known-name cast is justified: the membership test
 *  and the index use the SAME list. */
const lookupLiveReadout = (n: string): LiveReadoutRow | undefined =>
  (SOURCE_BACKED_READOUTS as readonly string[]).includes(n)
    ? LIVE_READOUTS[n as (typeof SOURCE_BACKED_READOUTS)[number]]
    : undefined

export const resolveReadout = async (
  name: string,
  snapshot: SessionSnapshotLite,
  sources: WebReadoutSources,
): Promise<ReadoutResult> => {
  const n = name.trim().toLowerCase()
  const live = lookupLiveReadout(n)
  if (live !== undefined) {
    try {
      const body = live(sources)
      // Only await what is actually a promise — a sync row must not gain a
      // microtask the original `switch` arm did not have.
      const output = body instanceof Promise ? await body : body
      if (output !== undefined) return served(n, output)
    } catch (error) {
      return sourceFailed(n, error)
    }
  }
  // Source absent / snapshot-served / skipped / unknown — the pure renderer
  // already answers all of those totally.
  return renderReadout(name, snapshot)
}

/** The names that serve LIVE data from the snapshot alone (source-backed names
 *  additionally serve live data whenever their accessor is composed). Exported
 *  so the web palette + a ratchet can enumerate the always-live set. */
export const SERVED_READOUTS: readonly string[] = ["state", "capabilities", "caps"]
