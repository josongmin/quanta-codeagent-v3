/**
 * @/agent-side implementation of the subagent slice's injected port.
 *
 * The subagent slice (`src/subagent/**`) deliberately does NOT import
 * `@/agent`; it depends only on the {@link SubagentRunner} signature. This
 * module is the host wire-up: it forks the real agent loop (`runAgent`) into a
 * child run with its own conversation seed, a filtered tool registry, a
 * dropped long-term store (a child must never persist into the parent's
 * memory), and an abort signal chained to the parent's.
 *
 * Recommended `AgentConfig` field (host wires this; OUT of this file's scope):
 *
 *   subagent?: { runner: SubagentRunner; maxDepth?: number }
 *
 * The host builds the runner with `createSubagentRunner(parentConfig, { ... })`
 * and threads it (plus `maxDepth`) onto the parent config so the `agent` tool
 * can spawn children.
 *
 * --- DEPTH SEAM + the recursion bound (accurate as of today) ---
 *
 * Recursion is bounded MULTI-LEVEL by `maxDepth` (the depth guard is real and
 * load-bearing) — read both parts:
 *
 *   1. `AgentConfig` carries an optional `depth?: number`
 *      (`src/agent/types.ts`); this runner sets it on the child to `req.depth`
 *      (see {@link buildChildConfig}), and `src/agent/dispatch.ts` surfaces it
 *      onto the ToolContext:
 *        const ctx: ToolContext =
 *          { cwd: config.cwd, signal: config.signal,
 *            ...(config.depth !== undefined ? { depth: config.depth } : {}) }
 *      Absent ⇒ omitted, slice duck-reads it as 0, root path byte-identical.
 *      The `agent` tool reads it via `ctxDepth` (`src/subagent/agent-tool.ts`).
 *
 *   2. {@link buildChildConfig} propagates `parent.subagent` into the child
 *      (but NOT `skills` — a subagent gets a clean tool surface). So a forked
 *      child's `runAgent` → `buildSessionFeatures` DOES register an `agent`
 *      tool: a child can spawn sub-subagents. Each level's `req.depth` is
 *      `parentDepth + 1` (via (1)), so this runner's `req.depth > maxDepth ⇒
 *      deny` guard (and the tool's mirror guard) terminate the recursion at
 *      `maxDepth` (default 3) with a recoverable deny tool_result — never an
 *      unbounded spawn.
 *
 * Consequence: depth is plumbed (1) AND exercised (2). The `req.depth >
 * maxDepth ⇒ deny, never throw` guard is the REAL, load-bearing recursion
 * bound (not belt-and-braces). Beyond maxDepth the nested `agent` call returns
 * a recoverable "max subagent depth exceeded" tool_result and the parent
 * continues. Verified end-to-end by tests/integration/subagent-fork-e2e.test.ts.
 *
 * --- CANCELLATION SEAM ---
 *
 * The child's `signal` is composed from TWO sources via {@link chainedSignal}:
 *   - Parent loop abort (`parent.signal`) — existing, propagates user/host
 *     cancellation down the fork tree.
 *   - Per-task abort (`req.signal`, driven by `TaskRegistry.stop(id)` from the
 *     `task_stop` tool) — NEW, lets an in-flight forked `runAgent` unwind on a
 *     targeted cancel without aborting the whole parent loop.
 * Either signal aborting aborts the child. Composition happens once in
 * {@link buildChildConfig} so both worktree-isolated and non-isolated paths
 * inherit it.
 *
 * --- CODEX SEED-AUGMENTATION SEAM ---
 *
 * The child's seed prompt is built by {@link buildSeedPrompt} from up to five
 * optional {@link SubagentRequest} fields. Full ordering when all set:
 *   1. `priorAttempt` block (Codex `resume_agent`, PREPENDED above prompt)
 *   2. `req.prompt`
 *   3. `ownedSurfaces` block (Codex ownership boundary)
 *   4. `forbiddenSurfaces` block (Codex ownership boundary)
 *   5. `checkpointPath` block (Codex `checkpoint`, operational guidance)
 *   6. `resultShape` block (Codex `expected_output_shape`)
 * When none are set the seed is byte-identical to `req.prompt`.
 */

import type { Message } from "@/llm"
import { isGitRepo, withWorktree } from "@/runtime"
import { runtimeConfig } from "@/shared"
import {
  type AgentMetaRegistry,
  assignNickname,
  SubagentTurnGate,
  type TurnWakeRegistry,
} from "@/subagent"
import { type Tool, ToolRegistry } from "@/tool"
import type { SubagentRequest, SubagentResult, SubagentRunner } from "../subagent/types"
import {
  buildLeaderDecide,
  buildLeaderHitlBroker,
  type LeaderEscalationDecider,
} from "./coordination-broker-wire"
import { runAgent } from "./loop"
import { isMutatingMode } from "./mode"
import type { NamedAgentDefinition, NamedAgentResolver } from "./named-agent-registry"
import { buildOwnershipPolicy } from "./ownership-policy"
import type { AgentMode } from "./prompt"
import {
  resolveChildEffort,
  resolveChildLlm,
  UnknownSubagentModelError,
} from "./subagent-runner-overrides"
import type { AgentConfig, AgentOutcome } from "./types"

export { UnknownSubagentModelError } from "./subagent-runner-overrides"

const DEFAULT_MAX_DEPTH = 3

/** Internal seam: tests inject a fake `runAgent` / git probes so the runner is
 *  unit-testable without a real LLM or a real git repo. Defaults are the real
 *  implementations. `isGitRepo`/`withWorktree` are injectable together because
 *  worktree isolation is otherwise an end-to-end-only path. */
export interface SubagentRunnerOptions {
  /** Hard recursion ceiling. `req.depth > maxDepth ⇒ denied`. Default 3. */
  maxDepth?: number
  /** Override the loop entrypoint (tests). Defaults to the real `runAgent`. */
  run?: typeof runAgent
  /** Override the git-repo probe (tests). Defaults to the real `isGitRepo`. */
  isGitRepo?: typeof isGitRepo
  /** Override the worktree wrapper (tests). Defaults to the real
   *  `withWorktree`. */
  withWorktree?: typeof withWorktree
  /** Injection seam for tests: clock used to suffix the subagent id. The id
   *  is purely filesystem-namespaced via `safeId`; the timestamp is a
   *  monotonic-ish source of uniqueness across siblings spawned in the same
   *  parent turn. Default `Date.now`. */
  now?: () => number
  /** B1 — OPT-IN closed-port tool-namespacing strategy. When set, the child's
   *  filtered tool registry is rewritten so the model sees SCOPED tool names
   *  (e.g. `root_0__exec_command`) and dispatch resolves them back to the real
   *  tools. This prevents name collisions when multiple sibling children run
   *  concurrently and their tool surfaces are surfaced to a shared consumer.
   *  Absent ⇒ raw names (byte-identical to today). See {@link namespaceRegistry}. */
  toolNamespace?: ToolNamespaceStrategy
}

/**
 * B1 — closed-port tool-namespacing strategy. Maps a raw tool name to a scoped
 * name given the child's stable namespace token (its mailbox label, e.g.
 * `root/0`). The strategy MUST be injective per-namespace (distinct raw names
 * map to distinct scoped names) so dispatch can round-trip. The runner builds
 * the child registry keyed by the scoped name; `dispatch.ts` resolves a tool
 * call via `registry.get(call.name)`, so a scoped name the model emits resolves
 * directly back to the real tool — no separate reverse map needed.
 */
export interface ToolNamespaceStrategy {
  /** `(namespaceToken, rawToolName) → scopedToolName`. */
  scope(namespaceToken: string, rawToolName: string): string
}

/** A sensible default strategy the host can opt into: `prefixToolNamespace`.
 *  Produces `${safe(token)}__${rawName}` where `safe` replaces any char outside
 *  `[A-Za-z0-9_]` with `_` (most tool-name validators / model APIs reject `/`
 *  and other punctuation, so the raw `root/0` label is sanitized). Injective
 *  per namespace because only the raw-name suffix varies within one token. */
export const prefixToolNamespace: ToolNamespaceStrategy = {
  scope(namespaceToken: string, rawToolName: string): string {
    const safe = namespaceToken.replace(/[^A-Za-z0-9_]/g, "_")
    return `${safe}__${rawToolName}`
  },
}

/** Apply a {@link ToolNamespaceStrategy} to a registry, returning a NEW
 *  registry whose tools carry scoped names. Each tool is shallow-cloned with
 *  only `name` overridden (unknown Tool fields are preserved via spread), so
 *  the model sees the scoped name AND dispatch (`registry.get(scopedName)`)
 *  resolves to the same `run`. Pure: the source registry is not mutated. */
const namespaceRegistry = (
  source: ToolRegistry,
  strategy: ToolNamespaceStrategy,
  namespaceToken: string,
): ToolRegistry => {
  const scoped = source.all().map((tool) => ({
    ...tool,
    name: strategy.scope(namespaceToken, tool.name),
  }))
  return new ToolRegistry(scoped)
}

/** Join the trailing assistant turn's text blocks into the child's answer.
 *  Mirrors the slice contract ("final assistant text the child produced"). */
const lastAssistantText = (messages: Message[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === "assistant") {
      const text = m.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim()
      if (text !== "") return text
    }
  }
  return ""
}

/** Map a finished {@link AgentOutcome} onto the slice's {@link SubagentResult}.
 *  `ok` is true only for a clean `completed`; everything else (max_turns,
 *  aborted, error) is a non-ok result the parent surfaces to the model. */
const toResult = (outcome: AgentOutcome): SubagentResult => ({
  ok: outcome.reason === "completed",
  finalText: lastAssistantText(outcome.messages),
  turns: outcome.turns,
  messages: outcome.messages,
})

/** Build the filtered child registry. The slice's `toolFilter` is a tool-name
 *  allowlist; we re-enumerate the parent registry via its public `specs()`
 *  names + `get(name)` (no private enumerator exists) and reconstruct a fresh
 *  {@link ToolRegistry} from the intersection. Absent filter ⇒ inherit the
 *  parent registry as-is. An empty/all-miss filter yields an empty registry
 *  (the child simply has no tools — it can still answer from the prompt). */
const filterRegistry = (
  parent: ToolRegistry,
  toolFilter: string[] | undefined,
  // GAP7-2 — per-dispatch tools the child gets IN ADDITION to the filtered set
  // (e.g. a batch row's `report_agent_job_result` bound to a fresh reporter).
  // Appended AFTER the filter so the allowlist never drops them. Absent ⇒
  // byte-identical to the pre-seam behavior.
  extraTools?: readonly Tool[],
): ToolRegistry => {
  const extra = extraTools ?? []
  const allTools = (): Tool[] =>
    parent
      .specs()
      .map((s) => parent.get(s.name))
      .filter((t): t is Tool => t !== undefined)
  if (!toolFilter) {
    if (extra.length === 0) return parent // no filter + no extras ⇒ inherit as-is
    return new ToolRegistry([...allTools(), ...extra])
  }
  const allow = new Set(toolFilter)
  const kept = parent
    .specs()
    .map((s) => s.name)
    .filter((name) => allow.has(name))
    .map((name) => parent.get(name))
    .filter((t): t is NonNullable<typeof t> => t !== undefined)
  return new ToolRegistry([...kept, ...extra])
}

/** Compose the child's {@link AbortSignal} from up to two sources: the parent
 *  loop's signal and an optional per-request signal (e.g. the `TaskRegistry`
 *  per-task controller driven by `task_stop`). Aborting EITHER source aborts
 *  the child. When `extra` is absent we return `parent` directly — the child
 *  config never aborts its own signal, so sharing the parent's is safe and
 *  keeps the no-extra path allocation-free. With `extra`, `AbortSignal.any`
 *  returns a fresh signal that aborts when ANY input aborts (already-aborted
 *  inputs produce an already-aborted result). */
const chainedSignal = (parent: AbortSignal, extra?: AbortSignal): AbortSignal =>
  extra ? AbortSignal.any([parent, extra]) : parent

/** Build the child's seed user-prompt text. When the caller sets NONE of the
 *  five opt-in fields (`priorAttempt`, `ownedSurfaces`, `forbiddenSurfaces`,
 *  `checkpointPath`, `resultShape`) the result is byte-identical to
 *  `req.prompt` (preserves the legacy non-opt-in call path — load-bearing
 *  regression invariant). Ordering rationale: prior context first (warm-start
 *  the child), then the task, then boundary constraints, then operational
 *  guidance (checkpoint), then the output spec. */
const buildSeedPrompt = (req: SubagentRequest): string => {
  const parts: string[] = []
  if (req.priorAttempt && req.priorAttempt.length > 0) {
    parts.push(
      `## Previous attempt's findings\n${req.priorAttempt}\n\n## Current task\n${req.prompt}`,
    )
  } else {
    parts.push(req.prompt)
  }
  if (req.ownedSurfaces && req.ownedSurfaces.length > 0) {
    parts.push(
      `**Owned surfaces** (you may read/modify these): ${req.ownedSurfaces.map((s) => `- ${s}`).join("\n")}`,
    )
  }
  if (req.forbiddenSurfaces && req.forbiddenSurfaces.length > 0) {
    parts.push(
      `**Forbidden surfaces** (do NOT touch): ${req.forbiddenSurfaces.map((s) => `- ${s}`).join("\n")}`,
    )
  }
  if (req.checkpointPath && req.checkpointPath.length > 0) {
    parts.push(
      `**Checkpoint**: Write your interim progress to \`${req.checkpointPath}\` every few turns (use the \`write\` or \`edit\` tool). The parent uses this file to monitor and to recover work if you are stopped.`,
    )
  }
  if (req.resultShape && req.resultShape.length > 0) {
    parts.push(`**Final answer format**: ${req.resultShape}`)
  }
  return parts.join("\n\n")
}

/**
 * §20.1/§20.2 — resolve the named-agent definition for this spawn (if any) and
 * fold it into an EFFECTIVE request. A definition is consulted ONLY when the
 * parent wired a `namedAgentResolver` AND `req.agentType` matches a loaded
 * definition; otherwise the original `req` is returned unchanged (the
 * byte-identical default-OFF path — no resolver, or no match).
 *
 * Precedence is EXPLICIT-REQUEST-WINS for every field (a caller's explicit
 * value always beats the definition's default — mirrors `taskKind`/`toolFilter`):
 *   - `system`     ← `req.system ?? def.system`
 *   - `toolFilter` ← `req.toolFilter ?? def.tools`   (narrow-only, see below)
 *   - `model`      ← `req.model ?? def.model`
 *   - `mode`       ← `req.mode ?? def.mode`
 *
 * SECURITY (tool widening — the crux): `def.tools` is REPO-CONTROLLED and is
 * carried ONLY as the spawn's `toolFilter`. `buildChildConfig` feeds that into
 * `filterRegistry(parent.registry, toolFilter)`, which INTERSECTS the names
 * against the PARENT registry's `specs()` (`allow.has(name)`). So a definition
 * naming a tool the parent never granted yields a child registry WITHOUT it —
 * the named definition can only NARROW, never widen. This function performs no
 * grant of its own.
 */
const applyNamedAgent = (parent: AgentConfig, req: SubagentRequest): SubagentRequest => {
  // Read the resolver via a structural accessor so this slice compiles whether
  // or not the (parent-owned) `AgentConfig.namedAgentResolver?: NamedAgentResolver`
  // field has landed yet — EMIT-BLOCK in the report adds it. No field ⇒
  // `undefined` ⇒ byte-identical default-OFF.
  const resolver = (parent as { namedAgentResolver?: NamedAgentResolver }).namedAgentResolver
  if (resolver === undefined || req.agentType === undefined || req.agentType.length === 0) {
    return req
  }
  const def: NamedAgentDefinition | undefined = resolver.resolve(req.agentType)
  if (def === undefined) return req
  // Explicit-request-wins on every field; the definition only supplies a
  // default for fields the caller left absent. `toolFilter` rides through
  // `filterRegistry` (intersection ⇒ narrow-only) so `def.tools` can never widen.
  return {
    ...req,
    ...(req.system === undefined ? { system: def.system } : {}),
    ...(req.toolFilter === undefined && def.tools !== undefined ? { toolFilter: def.tools } : {}),
    ...(req.model === undefined && def.model !== undefined ? { model: def.model } : {}),
    ...(req.mode === undefined && def.mode !== undefined ? { mode: def.mode } : {}),
  }
}

/** §20.1 — pick the child's role system prompt. `req.system` (set by an
 *  explicit caller OR a matched named-agent definition via `applyNamedAgent`)
 *  REPLACES the inherited `parent.system`; absent ⇒ `parent.system`
 *  (byte-identical). Extracted so the ternary lives outside `buildChildConfig`'s
 *  cognitive-complexity budget. */
const resolveChildSystem = (parent: AgentConfig, req: SubagentRequest): string =>
  req.system !== undefined && req.system.length > 0 ? req.system : parent.system

/** §20.2 — pick the child's prompt `mode`. A named-agent definition's `mode:`
 *  (folded into `req.mode`) overrides the inherited parent mode; absent ⇒ the
 *  child inherits `parent.mode` exactly as before (byte-identical). `req.mode`
 *  is a SSOT-validated string (the registry's `normalizeMode` only emits an
 *  `AGENT_PROMPT_MODES` member), so the narrowing cast carries no runtime risk.
 *  Returns a spread fragment so an absent mode omits the key entirely (honors
 *  exactOptionalPropertyTypes). */
const resolveChildMode = (
  parent: AgentConfig,
  req: SubagentRequest,
): Pick<AgentConfig, "mode"> | Record<string, never> => {
  const parentMode = parent.mode
  if (req.mode !== undefined && req.mode.length > 0) {
    const requested = req.mode as AgentMode
    // Most-restrictive clamp (SECURITY): a named-agent `mode:` (repo-controlled
    // definition, folded into `req.mode`) may FURTHER restrict the child but must
    // never RELAX a read-only parent (plan/review/audit/architect) into a
    // write-capable posture (default/editor). Without this, a definition
    // declaring `mode: default` would let a review-posture parent spawn a child
    // that invokes mutating tools — the exact escalation that unconditional
    // parent-mode inheritance prevented. A read-only parent therefore floors the
    // child; two mutating modes, or a parent that is already mutating, honor the
    // request as-is. Pinned by `named-agent-mode-clamp-hellgate`.
    if (parentMode !== undefined && !isMutatingMode(parentMode) && isMutatingMode(requested)) {
      return { mode: parentMode }
    }
    return { mode: requested }
  }
  return parentMode !== undefined ? { mode: parentMode } : {}
}

/**
 * Capability B (multi-agent coordination) — wire the leader-mediated escalation
 * broker onto the CHILD's admissibility bundle. DEFAULT-OFF: returns `{}` (no
 * `admissibility` slot ⇒ byte-identical legacy child) UNLESS `QUANTA_TEAM_BROKER`
 * is on AND the parent has an `onConfirm` authority (the leader's HITL) AND the
 * child has stable worker/leader mailbox ids. The decider wraps the LEADER's
 * `onConfirm` — a worker's SOFT-denied tool escalates to the leader's
 * confirmation; HARD_DENY is structurally never escalatable (enforced in the
 * gate). The correlation-id source is a deterministic per-child counter (NOT a
 * clock / random) so a recorded session re-mints identical ids.
 */
const maybeWireCoordinationBroker = (
  parent: AgentConfig,
  mailboxIds: { agentId: string; parentId: string },
): Pick<AgentConfig, "admissibility"> | Record<string, never> => {
  if (!runtimeConfig().teamBroker) return {}
  const onConfirm = parent.onConfirm
  if (onConfirm === undefined) return {} // no leader authority ⇒ nothing to escalate to
  const workerId = mailboxIds.agentId
  const leaderId = mailboxIds.parentId
  if (workerId.length === 0 || leaderId.length === 0) return {}

  // WS-A (jul-10, UUX-1-07) — the SSOT mapping (coordination-broker-wire's
  // `buildLeaderDecide`) replaces the prior inline collapse to `{approved}`:
  // the leader's deny_and_steer STEER and allow SCOPE now survive the boundary,
  // and a session-scoped allow is cached so the same ask never re-prompts.
  // UUX-6-12 — thread the worker's id so the leader's prompt names WHO asks.
  const leaderDecide: LeaderEscalationDecider = buildLeaderDecide(onConfirm, { workerId })

  let esc = 0
  const broker = buildLeaderHitlBroker({
    workerId,
    leaderId,
    leaderDecide,
    ...(parent.subagentMailbox ? { mailbox: parent.subagentMailbox } : {}),
    nextCorrelationId: () => `${workerId}#esc${esc++}`,
  })
  return { admissibility: { coordinationBroker: broker } }
}

/** RFC jun-6 (DELTA #2) — register a freshly-spawned child into the PARENT's
 *  team so siblings share a team bus. No-op when no team registry is wired
 *  (`teamPeerMsg` off) or the parent is un-teamed. The parent's mailbox label
 *  (`mailboxAgentId ?? "root"`) is its membership key. NO-THROW: a malformed
 *  registry call is swallowed (the spawn must never fail on a comms-channel
 *  bookkeeping error). */
const maybeRegisterChildTeam = (parent: AgentConfig, childLabel: string): void => {
  const registry = parent.teamRegistry
  if (registry === undefined) return
  const parentLabel = parent.mailboxAgentId ?? "root"
  const team = registry.teamOf(parentLabel)
  if (team === undefined) return // parent un-teamed ⇒ child stays un-teamed
  try {
    registry.addMember(team, childLabel)
  } catch {
    // bookkeeping only — never fail a spawn on a registry hiccup
  }
}

/** RFC jun-6 (DELTA #2) — SYMMETRIC teardown for {@link maybeRegisterChildTeam}.
 *  A finished child must LEAVE the parent's team: without this the roster grows
 *  unbounded over a session (every spawn adds, nothing removes) and the stale
 *  member keeps appearing in the team's broadcast-scope roster (`membersOf`) and
 *  passing `sameTeam`, so mail addressed to a dead child lingers undelivered.
 *  `removeMember` is a NO-OP when the child re-homed itself to another team
 *  (the registry guards `teamByAgent.get(child) === team`), so a child that
 *  ran `team_create` keeps its chosen team. NO-THROW: a teardown hiccup must
 *  never mask the child's real result. */
const maybeUnregisterChildTeam = (parent: AgentConfig, childLabel: string): void => {
  const registry = parent.teamRegistry
  if (registry === undefined) return
  const parentLabel = parent.mailboxAgentId ?? "root"
  const team = registry.teamOf(parentLabel)
  if (team === undefined) return
  try {
    registry.removeMember(team, childLabel)
  } catch {
    // bookkeeping only — never fail a teardown on a registry hiccup
  }
}

interface SharedChildIdentityState {
  readonly nextOrdinalByParent: Map<string, number>
  nextSpawnSeq: number
}

const sharedChildIdentityStates = new WeakMap<object, SharedChildIdentityState>()

const childIdentityAnchor = (parent: AgentConfig): object | undefined => {
  const candidate =
    parent.subagentTurnWake ??
    parent.teamRegistry ??
    parent.subagentMailbox ??
    parent.subagentAgentMeta ??
    parent.subagent?.taskRegistry
  return typeof candidate === "object" && candidate !== null ? candidate : undefined
}

const childIdentityState = (parent: AgentConfig): SharedChildIdentityState | undefined => {
  const anchor = childIdentityAnchor(parent)
  if (anchor === undefined) return undefined
  const existing = sharedChildIdentityStates.get(anchor)
  if (existing !== undefined) return existing
  const created: SharedChildIdentityState = { nextOrdinalByParent: new Map(), nextSpawnSeq: 0 }
  sharedChildIdentityStates.set(anchor, created)
  return created
}

const allocateChildMailboxIds = (
  parentLabel: string,
  shared: SharedChildIdentityState | undefined,
  local: { childOrdinal: number; spawnSeq: number },
): { agentId: string; parentId: string; spawnSeq: number } => {
  if (shared !== undefined) {
    const ordinal = shared.nextOrdinalByParent.get(parentLabel) ?? 0
    shared.nextOrdinalByParent.set(parentLabel, ordinal + 1)
    const spawnSeq = shared.nextSpawnSeq
    shared.nextSpawnSeq += 1
    return { agentId: `${parentLabel}/${ordinal}`, parentId: parentLabel, spawnSeq }
  }
  const ordinal = local.childOrdinal
  local.childOrdinal += 1
  const spawnSeq = local.spawnSeq
  local.spawnSeq += 1
  return { agentId: `${parentLabel}/${ordinal}`, parentId: parentLabel, spawnSeq }
}

const buildSubagentRunId = (
  depth: number,
  mailboxAgentId: string,
  spawnSeq: number,
  now: () => number,
): string => {
  const safeMailboxId = mailboxAgentId.replace(/[^A-Za-z0-9_-]/g, "_")
  return `sub-d${depth}-${safeMailboxId}-${now().toString(36)}-${spawnSeq.toString(36)}`
}

/** §20.3 — record a DISPLAY nickname for a freshly-spawned child in the host's
 *  `AgentMetaRegistry` side-table (the `list_agents` label source, keyed by the
 *  registry TASK id `rec.id`). The child's STABLE id stays the ordinal mailbox
 *  label (`root/0`); the nickname is a human-friendly maestro name
 *  DETERMINISTICALLY derived from that STABLE mailbox id via `assignNickname`
 *  (FNV-1a seed ⇒ same id always maps to the same name, so a recorded session
 *  re-mints identical labels). Prefers an explicit `agentType` (more
 *  informative) over the nickname, falling back to the nickname so an un-typed
 *  child shows "Karajan" instead of a bare description prefix. No-op when the
 *  host did not wire `subagentAgentMeta`, OR the spawn has no registry `taskId`
 *  to key on (foreground/legacy path) ⇒ byte-identical (the meta table stays
 *  empty exactly as before and `list_agents` keeps its `agentType`/description
 *  fallback). This is the wiring that turns `assignNickname` from dead code into
 *  the live display path. */
const recordChildNickname = (
  agentMeta: AgentMetaRegistry | undefined,
  taskId: string | undefined,
  mailboxAgentId: string,
  depth: number,
  agentType: string | undefined,
): void => {
  if (agentMeta === undefined || taskId === undefined || taskId.length === 0) return
  const nickname = assignNickname(mailboxAgentId)
  const label = agentType !== undefined && agentType.length > 0 ? agentType : nickname
  agentMeta.set(taskId, { depth, label })
}

/** Construct the CHILD {@link AgentConfig} by shallow-cloning `parent` and
 *  applying the subagent overrides (see the override table in the report).
 *  `store`/`hooks`/`metrics`/`run`/`sessionId`/`memory` are DROPPED so a child
 *  never persists into the parent's long-term memory or pollutes its
 *  correlation/observability; `llm`/`stream`/`permission`/`system` are kept.
 *  Seed is `[{ role: "user", content: [{ type: "text", text:
 *  buildSeedPrompt(req) }] }]` — see {@link buildSeedPrompt} for the
 *  five-field (priorAttempt / ownedSurfaces / forbiddenSurfaces /
 *  checkpointPath / resultShape) augmentation rules. */

/** The child's mailbox-identity fields: its UNIQUE mailbox label, its parent's
 *  label, and (when spawned with a registry task) its OWN task id for the
 *  `followup_task` self-target guard (BUG#4). Extracted so `buildChildConfig`
 *  stays under the cognitive-complexity cap. */
const childMailboxIdentity = (
  mailboxIds: { agentId: string; parentId: string },
  req: SubagentRequest,
): { mailboxAgentId: string; mailboxParentId: string; subagentTaskId?: string } => ({
  mailboxAgentId: mailboxIds.agentId,
  mailboxParentId: mailboxIds.parentId,
  ...(req.taskId !== undefined ? { subagentTaskId: req.taskId } : {}),
})

const buildChildConfig = (
  parent: AgentConfig,
  rawReq: SubagentRequest,
  cwd: string,
  mailboxIds: { agentId: string; parentId: string },
  toolNamespace?: ToolNamespaceStrategy,
  turnGate?: SubagentTurnGate,
): AgentConfig => {
  // §20.1/§20.2 — fold a matching named-agent definition into the request
  // (system / toolFilter / model / mode), explicit-request-wins. No resolver or
  // no match ⇒ `req === rawReq` (byte-identical). `def.tools` only ever NARROWS
  // (it rides `toolFilter` → `filterRegistry` intersection).
  const req = applyNamedAgent(parent, rawReq)
  const seed: Message[] = [
    { role: "user", content: [{ type: "text", text: buildSeedPrompt(req) }] },
  ]
  // B1 — start from the parent's ALLOW-LIST-filtered registry (unchanged
  // default path). When a namespacing strategy is injected, rewrite it so the
  // child's tools carry scoped names (keyed by the scoped name, so dispatch
  // round-trips). The child's mailbox label (`mailboxIds.agentId`, e.g.
  // `root/0`) is the per-child namespace token — distinct per sibling, so
  // concurrent siblings cannot collide. Absent ⇒ raw names (byte-identical).
  const filtered = filterRegistry(parent.registry, req.toolFilter, req.extraTools)
  const childRegistry =
    toolNamespace !== undefined
      ? namespaceRegistry(filtered, toolNamespace, mailboxIds.agentId)
      : filtered
  // ADR-0451 — resolve the child's effective LLM port (explicit model > role >
  // parent) and optional effort thunk. With NO override on the request these
  // collapse to `parent.llm` and `undefined` (no sessionEffort wired) — the
  // exact pre-ADR-0451 child config (byte-identical). A bad model id throws
  // UnknownSubagentModelError here (fail-closed); the runner's catch turns it
  // into a non-ok SubagentResult.
  const childLlm = resolveChildLlm(parent, req)
  const childEffort = resolveChildEffort(req)
  // §20.1 — the child's role system prompt: an explicit caller `req.system` OR a
  // matched named-agent definition (folded into `req.system` by
  // `applyNamedAgent`); absent ⇒ inherit `parent.system` (byte-identical).
  const childSystem = resolveChildSystem(parent, req)
  // §20.4 (ticket-12) — assemble the ENFORCED ownership policy from the request's
  // owned/forbidden surfaces (canonicalized against the child cwd) ONLY when the
  // strict `QUANTA_FS_OWNERSHIP_ENFORCE` knob is on. No surfaces / knob off ⇒
  // `undefined` ⇒ the surfaces stay advisory seed-prompt guidance (byte-identical).
  const ownershipPolicy = buildOwnershipPolicy({
    ...(req.ownedSurfaces ? { owned: req.ownedSurfaces } : {}),
    ...(req.forbiddenSurfaces ? { forbidden: req.forbiddenSurfaces } : {}),
    cwd,
    enforced: runtimeConfig().fsOwnershipEnforce,
  })
  // Shallow clone, then strip the inheritance-unsafe keys. We rebuild the
  // object explicitly (rather than `delete`) to satisfy
  // exactOptionalPropertyTypes: omit keys entirely, never assign `undefined`.
  const child: AgentConfig = {
    llm: childLlm,
    registry: childRegistry,
    // jul-7 audit (F1): carry the child's tool allowlist so `buildEffectiveConfig`
    // intersects the feature tools (spawn_agent / team_*) with it too — a restricted
    // child must not re-acquire, via the feature layer, tools its registry filter denied.
    // Same value fed to `filterRegistry` above ⇒ consistent. Absent ⇒ no feature filter.
    ...(req.toolFilter !== undefined ? { toolAllowlist: req.toolFilter } : {}),
    stream: parent.stream,
    permission: parent.permission,
    messages: seed,
    // §20.1 — role-specialized system prompt (see `resolveChildSystem`). Absent
    // override ⇒ `parent.system` (byte-identical to pre-§20.1).
    system: childSystem,
    cwd,
    // §20.4 — the enforced FS ownership boundary (undefined ⇒ advisory legacy).
    ...(ownershipPolicy !== undefined ? { ownershipPolicy } : {}),
    maxTurns: req.budget?.maxTurns ?? parent.maxTurns,
    // Child abort is composed from BOTH the parent loop's signal and the
    // per-request signal (driven by `TaskRegistry.stop(id)` from `task_stop`).
    // Either source aborting unwinds the forked `runAgent`. See chainedSignal.
    signal: chainedSignal(parent.signal, req.signal),
    // Recursion-depth marker; dispatch.ts surfaces it onto ToolContext so the
    // child's `agent` tool computes `childDepth = depth+1`. With `subagent`
    // propagated below, this is LOAD-BEARING: the maxDepth guard actually
    // bounds real multi-level recursion. Duck-typed cast sets it
    // unconditionally without tripping exactOptionalPropertyTypes.
    ...({ depth: req.depth } as { depth: number }),
    // ADR-0416 sibling-identity fix — thread the DETERMINISTIC mailbox label
    // for this child (`parentLabel/seq`) + the parent's label. dispatch.ts
    // surfaces these onto ToolContext.agentLabel / parentAgentLabel so the
    // subagent-mailbox tools address each sibling UNIQUELY (audit H). The
    // mailbox PORT itself is propagated below so the child shares the parent's
    // single in-memory mailbox instance (a child fork can both send and read).
    // ADR-0416 sibling identity + ADR-0437 self-target id (BUG#4). See
    // {@link childMailboxIdentity}. `req.taskId` absent ⇒ `subagentTaskId`
    // omitted (byte-identical foreground/legacy path).
    ...childMailboxIdentity(mailboxIds, req),
    // Propagated so a forked child can participate in the SAME inter-agent
    // mailbox (parent↔child + sibling↔sibling). The port is an in-process
    // shared-by-reference instance — safe across the worktree-isolation fork.
    ...(parent.subagentMailbox ? { subagentMailbox: parent.subagentMailbox } : {}),
    // RFC jun-6 (DELTA #2) — propagate the team registry so a forked child shares
    // the SAME membership scope (and can itself create/delete teams + the
    // cross-team deny applies to it). Absent ⇒ no team boundary (byte-identical).
    ...(parent.teamRegistry ? { teamRegistry: parent.teamRegistry } : {}),
    // RFC jun-6 (DELTA #1) — propagate the auto-delivery drain so the child's
    // turn loop AUTO-receives peer mail addressed to ITS label (the drain takes
    // the agent id at call time — one shared port drains every label). Absent ⇒
    // the child must manually poll (byte-identical default-OFF).
    ...(parent.peerInbox ? { peerInbox: parent.peerInbox } : {}),
    // ADR-0437 follow-up — THIS child's own turn gate (never the parent's).
    // The child loop parks on it at clean-completion so a `followup_task`
    // wake (registered against this child's task id in the runner below) can
    // trigger another turn. Absent ⇒ the child finishes immediately on
    // completion (byte-identical legacy / no-followup path).
    ...(turnGate !== undefined ? { subagentTurnGate: turnGate } : {}),
    // ADR-0451 — the child's effort source. Wired ONLY when `req.effort` named a
    // recognised tier; the child loop reads this each turn and caps its thinking
    // budget via `effortToTokenBudget` (the SAME seam as `sessionEffort`/skill
    // effort). Absent ⇒ omitted, so the child has no session-effort source
    // exactly as before (byte-identical no-override path).
    ...(childEffort !== undefined ? { sessionEffort: childEffort } : {}),
    // Kept (safe to share, no parent-state mutation):
    ...(parent.onConfirm ? { onConfirm: parent.onConfirm } : {}),
    ...(parent.embedder ? { embedder: parent.embedder } : {}),
    ...(parent.compaction ? { compaction: parent.compaction } : {}),
    ...(parent.planMode !== undefined ? { planMode: parent.planMode } : {}),
    // Codex-absorption inheritance (Round 2 fix): a child fork MUST
    // inherit the parent's safety / interaction posture or read-only modes
    // (review/audit) silently broaden in the child. Read-only modes block
    // mutating tools at dispatch — if the child collapses to `default`, a
    // review-posture parent could spawn a child that writes. Verify/closeout
    // guards and HITL 4-tier are also safety contracts the child must honor.
    // §20.2 — a named-agent definition's `mode:` (folded into `req.mode` by
    // `applyNamedAgent`, already validated against the prompt-mode SSOT) sets the
    // child's posture; absent ⇒ inherit the parent's mode (byte-identical). The
    // SSOT membership check happened registry-side, so the cast is contract-safe.
    ...resolveChildMode(parent, req),
    ...(parent.verifyGuard !== undefined ? { verifyGuard: parent.verifyGuard } : {}),
    ...(parent.closeoutGuard !== undefined ? { closeoutGuard: parent.closeoutGuard } : {}),
    ...(parent.hitl !== undefined ? { hitl: parent.hitl } : {}),
    // Propagated so a child can itself spawn sub-subagents — recursion is
    // bounded by the depth marker above + this runner's `req.depth > maxDepth`
    // deny guard (now the real, exercised bound, not belt-and-braces). Skills
    // are intentionally NOT propagated (a subagent gets a clean tool surface).
    ...(parent.subagent ? { subagent: parent.subagent } : {}),
    // Capability B — leader-mediated escalation broker on the child's
    // admissibility bundle. Default-OFF (empty spread) unless QUANTA_TEAM_BROKER
    // is on + the parent has an onConfirm authority. See the helper above.
    ...maybeWireCoordinationBroker(parent, mailboxIds),
    // DROPPED on purpose: store, sessionId, memory, hooks, metrics, run,
    // repoRules, globRules, workingState. A subagent must not write into the
    // parent's durable memory, emit into the parent's hook bus / metrics, or
    // share its correlation context. `repoRules` / `globRules` are dropped
    // because the child may run in a different `cwd` (worktree fork), where the
    // parent's file-scoped rules are stale authority. `workingState` is
    // session-scoped (Codex memory L3) — each agent gets a fresh scratchpad.
  }
  return child
}

/**
 * Build the @/agent-side {@link SubagentRunner}. The host calls this once with
 * the parent {@link AgentConfig} and threads the returned runner (plus the
 * recommended `subagent.maxDepth`) so the `agent` tool can fork the loop.
 *
 * Each invocation:
 *  - DEPTH GUARD: `req.depth > maxDepth ⇒` resolve a non-ok result (never
 *    throw) — this is the authoritative recursion bound.
 *  - builds a child config (see {@link buildChildConfig} / override table);
 *  - `isolation:"worktree"` + the effective child cwd is a git repo ⇒ run
 *    inside a throwaway worktree (`withWorktree`) with the child cwd =
 *    worktree path; not a git repo ⇒ silently fall back to no isolation
 *    (never fail);
 *  - maps the {@link AgentOutcome} onto a {@link SubagentResult}.
 */
export const createSubagentRunner = (
  parent: AgentConfig,
  opts: SubagentRunnerOptions = {},
): SubagentRunner => {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
  const run = opts.run ?? runAgent
  const gitProbe = opts.isGitRepo ?? isGitRepo
  const wt = opts.withWorktree ?? withWorktree
  const now = opts.now ?? Date.now
  // B1 — undefined ⇒ raw tool names (default, byte-identical). When set, child
  // registries are rewritten with scoped names per the injected strategy.
  const toolNamespace = opts.toolNamespace

  // ADR-0416 sibling-identity fix — this runner's parent mailbox label and the
  // session-shared child-identity allocator (when a shared mailbox/team/wake/
  // agent-meta substrate exists). Multiple runner instances that share one
  // control plane therefore mint from ONE ordinal sequence instead of each
  // restarting at `root/0`. Without a shared substrate we fall back to the
  // historical per-runner counter (byte-identical legacy path).
  const parentMailboxLabel = parent.mailboxAgentId ?? "root"
  const sharedIdentity = childIdentityState(parent)
  const localIdentity = { childOrdinal: 0, spawnSeq: 0 }

  return async (req: SubagentRequest): Promise<SubagentResult> => {
    if (req.depth > maxDepth) {
      return { ok: false, finalText: "max subagent depth exceeded", turns: 0 }
    }

    // Isolation guarantee (jul-7 audit F4, verified): when `isolate` holds, the child's
    // `cwd` is the throwaway worktree path (below), and BOTH write surfaces are jailed to
    // that cwd — `edit`/`write`/`apply_patch` via `FsJailFileSystemPort({jailRoot: ctx.cwd})`
    // (default, rejects out-of-worktree paths with FsJailViolationError) and `exec_command`'s
    // model-supplied `cwd` via the `cwdJail{jailRoot: config.cwd}` port (rejects `..` climb-out,
    // `subagent-shell-deny-jail-hellgate` HELLGATE-c). RESIDUAL (documented, not a regression):
    // a `bash` command containing an ABSOLUTE path (`echo x > /outside`) is NOT confined —
    // quanta has no OS-level exec sandbox (seatbelt/landlock), so that is a fundamental limit,
    // not a fixable jail gap. So worktree isolation = real for the structured file tools + the
    // exec cwd; treat raw shell absolute-path writes as still able to reach the parent tree.
    const requestedCwd = req.workspace ?? parent.cwd
    const mailboxIds = allocateChildMailboxIds(parentMailboxLabel, sharedIdentity, localIdentity)
    const subagentId = buildSubagentRunId(req.depth, mailboxIds.agentId, mailboxIds.spawnSeq, now)

    const wantsWorktree = req.isolation === "worktree"
    const isolate = wantsWorktree && (await gitProbe(requestedCwd))

    // ADR-0133 — fire `subagent_start` on the PARENT's hook bus BEFORE the
    // child config is built or the worktree is opened. A hook returning
    // `abort` cancels the spawn entirely. See `emitSubagentStartHook`.
    const startAbort = await emitSubagentStartHook(parent, { subagentId, req })
    if (startAbort !== null) {
      return { ok: false, finalText: startAbort, turns: 0 }
    }

    // RFC jun-6 (DELTA #2) — register the spawned child into the PARENT's team
    // (if the parent belongs to one) so siblings share a team bus + the
    // cross-team deny applies. No-op when `teamPeerMsg` is off (no registry) or
    // the parent is un-teamed (byte-identical default-OFF).
    maybeRegisterChildTeam(parent, mailboxIds.agentId)

    // §20.3 — record this child's display nickname in the host's AgentMeta
    // side-table (keyed by the registry task id). Deterministically seeded from
    // the STABLE mailbox id so `list_agents` shows a friendly maestro name.
    // No-op without `subagentAgentMeta` or a `taskId` (byte-identical).
    recordChildNickname(
      parent.subagentAgentMeta,
      req.taskId,
      mailboxIds.agentId,
      req.depth,
      req.agentType,
    )

    // ADR-0437 follow-up — mint a per-child turn gate + register a waker into
    // the host's shared `TurnWakeRegistry` under the SAME registry task id
    // `followup_task` targets, so `wake(taskId)` finds a live receiver. Absent
    // wake registry OR absent `req.taskId` ⇒ `gate` undefined + no waker
    // (byte-identical legacy / foreground path). The disposer runs in
    // `finally` so a wake on a finished child reports `no-receiver`.
    const wakerWiring = registerChildWaker(parent.subagentTurnWake, req.taskId, mailboxIds.agentId)
    const turnGate = wakerWiring?.gate

    try {
      const rawChildResult: SubagentResult = isolate
        ? toResult(
            (
              await wt(subagentId, requestedCwd, async (worktreePath) => {
                const child = buildChildConfig(
                  parent,
                  req,
                  worktreePath,
                  mailboxIds,
                  toolNamespace,
                  turnGate,
                )
                return run(child)
              })
            ).value,
          )
        : toResult(
            await run(
              buildChildConfig(parent, req, requestedCwd, mailboxIds, toolNamespace, turnGate),
            ),
          )

      // UX honesty (jul-7 audit F5): `isolation:"worktree"` was REQUESTED but could not be
      // honored — the workspace is not a git repo — so the child ran in the SHARED parent
      // working directory with NO write isolation. Surface it to the caller instead of the
      // prior SILENT fallback: a caller relying on isolation must know it did not happen.
      const childResult: SubagentResult =
        wantsWorktree && !isolate
          ? {
              ...rawChildResult,
              finalText: `⚠️ isolation:"worktree" requested but NOT achieved — this workspace is not a git repository, so the subagent ran in the SHARED parent working directory (no write isolation). Its file changes affect the parent tree.\n\n${rawChildResult.finalText}`,
            }
          : rawChildResult

      // ADR-0133 — fire `subagent_stop` after the child completes (any reason).
      await emitSubagentStopHook(parent, { subagentId, result: childResult })

      return childResult
    } finally {
      // Dispose BEFORE the registry settles the task so a `followup_task` that
      // races completion sees `no-receiver` (honest degrade) rather than a
      // wake into a dead loop. The disposer also unregisters the waker.
      wakerWiring?.dispose()
      // RFC jun-6 (DELTA #2) — SYMMETRIC team teardown: a finished child leaves
      // the parent's team so the roster does not grow unbounded and no stale
      // member lingers in the broadcast scope / sameTeam gate. No-op when the
      // child re-homed itself or no registry is wired (byte-identical default).
      maybeUnregisterChildTeam(parent, mailboxIds.agentId)
    }
  }
}

/**
 * ADR-0437 follow-up — mint a per-child {@link SubagentTurnGate} and register a
 * {@link import("@/subagent").Waker} bridging the host's shared
 * {@link TurnWakeRegistry} to that gate, keyed by the child's registry task id.
 *
 * Returns `undefined` when there is no wake substrate (`wake` registry absent)
 * OR no task id to key on — both cases are the byte-identical default-OFF path
 * (no gate is wired onto the child, so its loop finishes immediately on
 * completion exactly as before). When wired, the returned `gate` is threaded
 * onto the child config and the `dispose` MUST be called when the child loop
 * ends (unregisters the waker AND releases any park).
 */
const registerChildWaker = (
  wake: TurnWakeRegistry | undefined,
  taskId: string | undefined,
  mailboxLabel: string,
): { gate: SubagentTurnGate; dispose: () => void } | undefined => {
  if (wake === undefined || taskId === undefined) return undefined
  const gate = new SubagentTurnGate()
  // The waker maps the gate's `woke`/`queued` 1:1 onto the registry's
  // `WakeOutcome` (the third outcome, `no-receiver`, is produced by the
  // registry itself when no waker is registered — never by the waker). The
  // mailbox label is bound alongside so `followup_task` can translate this
  // child's task id → its inbox address (`root/N`) and deliver to the REAL
  // mailbox the child drains, not the phantom task-id address (BUG#4 fix).
  const unregister = wake.register(taskId, (reason: string) => gate.wake(reason), mailboxLabel)
  return {
    gate,
    dispose: (): void => {
      unregister()
      gate.dispose()
    },
  }
}

/** ADR-0133 — emit the `subagent_start` hook on the PARENT's bus. Returns
 *  `null` to proceed with the spawn, or a synthetic `finalText` string when
 *  a hook aborted. Extracted from the runner to keep its complexity below
 *  the biome cap. Children inherit no hook bus (`buildChildConfig` drops
 *  it on purpose) so this is the only level that can observe the fork
 *  lifecycle. */
const emitSubagentStartHook = async (
  parent: AgentConfig,
  q: { subagentId: string; req: SubagentRequest },
): Promise<string | null> => {
  if (parent.hooks === undefined) return null
  // Defensive: a test stub may return `undefined` (not a proper
  // HookEmitResult). Treat that as "no extras".
  const emit = (await parent.hooks.emit({
    type: "subagent_start",
    subagentId: q.subagentId,
    parentId: parent.run?.runId,
    taskPrompt: q.req.prompt,
  })) ?? { deny: null }
  if (emit.abort !== undefined) {
    return `subagent_start hook aborted: ${emit.abort.reason}`
  }
  // promptHook on subagent_start is queued for the PARENT (it sees it when
  // control returns). The parent loop reads its own
  // `subagentPendingPrompt` collector; if the host has not wired one, the
  // response is dropped silently — a host that wants the channel wires the
  // collector explicitly. (See `subagentPendingPrompt` in AgentConfig —
  // ADR-0133 surface extension.)
  if (emit.promptHook !== undefined) {
    parent.subagentPendingPrompt?.push(emit.promptHook)
  }
  return null
}

/** ADR-0133 — emit the `subagent_stop` hook on the PARENT's bus. promptHook
 *  is the only response field honored here; an `abort` on subagent_stop is
 *  meaningless (the child already finished). */
const emitSubagentStopHook = async (
  parent: AgentConfig,
  q: { subagentId: string; result: SubagentResult },
): Promise<void> => {
  if (parent.hooks === undefined) return
  const emit = (await parent.hooks.emit({
    type: "subagent_stop",
    subagentId: q.subagentId,
    result: {
      ok: q.result.ok,
      finalText: q.result.finalText,
      turns: q.result.turns,
    },
  })) ?? { deny: null }
  if (emit.promptHook !== undefined) {
    parent.subagentPendingPrompt?.push(emit.promptHook)
  }
}
