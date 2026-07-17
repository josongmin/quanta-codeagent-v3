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
import { projectToSubagentObservation } from "@/protocol/subagent"
import { isGitRepo, withWorktree } from "@/runtime"
import {
  type AgentMetaRegistry,
  assignNickname,
  type SubagentLifecycleEvent,
  SubagentTurnGate,
  type TaskRegistry,
} from "@/subagent"
import type { SubagentRequest, SubagentResult, SubagentRunner } from "../subagent/types"
import type { ConversationActionPort } from "./conversation-action"
import { createConversationActionSurface } from "./conversation-action-surface"
import { runAgent } from "./loop"
import { canExposeSpawnTools, childDepthOf, effectiveCap, SpawnLineageError } from "./spawn-depth"
import { emitSpawnDepthDecision } from "./spawn-depth-telemetry"
import {
  type ChildControlSurface,
  createChildControlEndpoint,
  createChildControlSurface,
} from "./subagent-control-endpoint"
import type { SubagentControlEndpoint, SubagentSteerSubmission } from "./subagent-delivery/ports"
import { buildChildConfig } from "./subagent-runner-child-config"
import type { ToolNamespaceStrategy } from "./subagent-tool-namespace"
import type { AgentConfig, AgentOutcome } from "./types"

export { UnknownSubagentModelError } from "./subagent-runner-overrides"

/** WS2 (RFC jul-18 §4.2) — the child steer-queue hard bound. A remote-steer
 *  burst that overflows this degrades ONCE to a mailbox queue (`action_queue_full`,
 *  handled by WS3); the surface never grows past it. */
const CHILD_STEER_QUEUE_CAPACITY = 8
/** WS2 — the child steer max input size (bytes), reused by the steer authority.
 *  Mirrors the `followup_task` 8KB message cap so a delivered steer body and a
 *  mailbox message share one ceiling. */
const CHILD_STEER_MAX_INPUT_BYTES = 8192

/** WS2 — the control bits threaded onto the child config ONLY when the control
 *  capability is wired (a shared wake registry + a `req.taskId`). The child
 *  loop reads `conversationActionPort` (drains one action per turn) and writes
 *  `activeTurnRef.current` (the endpoint's steer closure reads it). Absent ⇒ the
 *  prior child config shape (RFC §4.2 RED rail). */
interface ChildControlWiring {
  readonly conversationActionPort: ConversationActionPort
  readonly activeTurnRef: NonNullable<AgentConfig["activeTurnRef"]>
  /** The bounded steer-submission surface (retained for the loop drain). */
  readonly steerSurface: ChildControlSurface
  /** WS4 — the loop-facing steer drain view + finalization port, threaded onto
   *  the child config ONLY when the session steer plane exists (gate ON). Absent
   *  ⇒ the child loop runs NO safe-point drain (byte-identical default-OFF). */
  readonly childSteerDrain?: NonNullable<AgentConfig["childSteerDrain"]>
  readonly steerFinalization?: NonNullable<AgentConfig["steerFinalization"]>
}

// RFC jul-13 §4.2 (rev.4 MIN-CAP) — the runner's depth ceiling is the SAME
// `effectiveCap(opts.maxDepth) = min(spawnDepthCap() policy, opts.maxDepth ?? +∞)`
// the tier1 block builders gate on, so the runner-holding bypass paths
// (background / delegate — they never pass through a block builder) obey the
// identical cap. An explicit host `opts.maxDepth` can only TIGHTEN the operator
// policy, never RAISE it above the ceiling (see `effectiveCap(...)` below).

/** Internal seam: tests inject a fake `runAgent` / git probes so the runner is
 *  unit-testable without a real LLM or a real git repo. Defaults are the real
 *  implementations. `isGitRepo`/`withWorktree` are injectable together because
 *  worktree isolation is otherwise an end-to-end-only path. */
export interface SubagentRunnerOptions {
  /** Per-config TIGHTENING-ONLY cap request (rev.4 min-cap). The effective
   *  ceiling is `min(operator policy, maxDepth ?? +∞)`; the lineage-derived
   *  child depth exceeding it ⇒ denied. Omitted ⇒ operator policy (default 1). */
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

export { prefixToolNamespace, type ToolNamespaceStrategy } from "./subagent-tool-namespace"

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

interface ChildExecution {
  parent: AgentConfig
  req: SubagentRequest
  subagentId: string
  requestedCwd: string
  isolate: boolean
  mailboxIds: { agentId: string; parentId: string }
  toolNamespace: ToolNamespaceStrategy | undefined
  turnGate: SubagentTurnGate | undefined
  control: ChildControlWiring | undefined
  spawnedAsTaskId: string | undefined
  run: typeof runAgent
  withWorktree: typeof withWorktree
}

/** Run the child once, selecting the worktree wrapper only after admission. */
const executeChild = async ({
  parent,
  req,
  subagentId,
  requestedCwd,
  isolate,
  mailboxIds,
  toolNamespace,
  turnGate,
  control,
  spawnedAsTaskId,
  run,
  withWorktree: wt,
}: ChildExecution): Promise<SubagentResult> => {
  const configAt = (cwd: string): AgentConfig =>
    buildChildConfig(
      parent,
      req,
      cwd,
      mailboxIds,
      toolNamespace,
      turnGate,
      spawnedAsTaskId,
      undefined, // childRuntime — use the default `runtimeConfig()`
      control,
    )
  if (!isolate) return toResult(await run(configAt(requestedCwd)))
  const outcome = await wt(subagentId, requestedCwd, async (worktreePath) =>
    run(configAt(worktreePath)),
  )
  return toResult(outcome.value)
}

/** RFC jun-6 (DELTA #2) — register a spawned child into its parent's team.
 *  Registry failures are bookkeeping-only and must not fail the spawn. */
const maybeRegisterChildTeam = (parent: AgentConfig, childLabel: string): void => {
  const registry = parent.teamRegistry
  if (registry === undefined) return
  const team = registry.teamOf(parent.mailboxAgentId ?? "root")
  if (team === undefined) return
  try {
    registry.addMember(team, childLabel)
  } catch {
    // Team membership does not own the child execution lifecycle.
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

type ChildDepthAdmission = { readonly childDepth: number } | { readonly denied: SubagentResult }

/** Resolve and telemetry-record the authority-derived spawn depth once. */
const admitChildDepth = (parent: AgentConfig, maxDepth: number): ChildDepthAdmission => {
  const parentDepth = parent.depth ?? 0
  const toolExposed = canExposeSpawnTools(parentDepth, maxDepth)
  let childDepth: number
  try {
    childDepth = childDepthOf(parent)
  } catch (e) {
    if (!(e instanceof SpawnLineageError)) throw e
    emitSpawnDepthDecision({
      parentDepth,
      childDepth: null,
      maxDescendantDepth: maxDepth,
      toolExposed,
      decision: "denied_malformed",
    })
    return { denied: { ok: false, finalText: `spawn denied: ${e.message}`, turns: 0 } }
  }
  if (childDepth > maxDepth) {
    emitSpawnDepthDecision({
      parentDepth,
      childDepth,
      maxDescendantDepth: maxDepth,
      toolExposed,
      decision: "denied_by_depth",
    })
    return {
      denied: {
        ok: false,
        finalText: `max subagent depth (${maxDepth}) exceeded — complete this task yourself, do not spawn.`,
        turns: 0,
      },
    }
  }
  emitSpawnDepthDecision({
    parentDepth,
    childDepth,
    maxDescendantDepth: maxDepth,
    toolExposed,
    decision: "admitted",
  })
  return { childDepth }
}

/**
 * Multi-agent-panel SUBSTRATE — install the shared registry's lifecycle emit
 * sink from `parent.onSubagentEvent` (mirror of the `onAgentState` tap). The
 * registry emits its duck-declared {@link SubagentLifecycleEvent}; this closure
 * projects it to a `@/protocol/subagent` `SubagentObservation` (re-scrubbed,
 * defense-in-depth) before handing it to the host sink. No-op when either the
 * sink OR the shared registry is absent (byte-identical OFF). Idempotent:
 * setting the SAME sink twice (two runners over one registry) is harmless.
 */
const installSubagentEmitter = (parent: AgentConfig): void => {
  const sink = parent.onSubagentEvent
  const registry = parent.subagent?.taskRegistry
  if (sink === undefined || registry === undefined) return
  registry.setEmitter((event: SubagentLifecycleEvent) => {
    // The lifecycle event is structurally a subset of `AgentEvent`; the
    // projector maps + re-redacts it. A null (unexpected type) is dropped.
    const obs = projectToSubagentObservation(
      event as Parameters<typeof projectToSubagentObservation>[0],
    )
    if (obs !== null) sink(obs)
  })
}

/**
 * Multi-agent-panel SUBSTRATE — ensure the spawned child has a lineage
 * `TaskRecord` in the shared registry, and return the child's effective task id
 * (its OWN id, to thread as `spawnedAsTaskId`). This is the seam that makes
 * `registry.list()` reconstruct a real parent→child TREE.
 *
 *   - No shared registry ⇒ `undefined` (foreground/legacy path stays
 *     byte-identical: nothing registered, no `spawnedAsTaskId` threaded).
 *   - `req.taskId` already set (background / 6-tool pre-registered by the tool
 *     layer) ⇒ STAMP the lineage edge (`parentTaskId` / `depth` / `mailboxLabel`)
 *     onto that existing record (mutating it in place; the emit already fired at
 *     its `register()`), and return it.
 *   - `req.taskId` absent (foreground spawn) ⇒ REGISTER a fresh lineage record
 *     (emitting `subagent_spawn` if a sink is wired) and return its id.
 *
 * `parentTaskId` is `parent.spawnedAsTaskId` — undefined at the root ⇒ the
 * direct child is root-level.
 */
const ensureLineageTask = (
  parent: AgentConfig,
  req: SubagentRequest,
  childDepth: number,
  mailboxLabel: string,
):
  | { registry: TaskRegistry; taskId: string; settle: (result: SubagentResult) => void }
  | undefined => {
  const registry = parent.subagent?.taskRegistry
  if (registry === undefined) return undefined
  const parentTaskId = parent.spawnedAsTaskId
  const description = req.prompt.slice(0, 120)
  if (req.taskId !== undefined) {
    // Background / 6-tool: the tool layer already `register()`ed this id. Stamp
    // the lineage edge onto the existing record so the tree is complete. Do NOT
    // re-register (that would reset status + double-emit).
    const existing = registry.get(req.taskId)
    if (existing !== undefined) {
      const stamped = existing as {
        parentTaskId?: string
        depth: number
        mailboxLabel?: string
      }
      if (parentTaskId !== undefined) stamped.parentTaskId = parentTaskId
      stamped.depth = childDepth
      stamped.mailboxLabel = mailboxLabel
      // The tool layer already emitted a provisional `depth:0` / no-parent spawn
      // at its `register()` (lineage wasn't known yet). Re-emit the CORRECTED
      // spawn so the web panel's tree reflects the real parent/depth (no-op when
      // the panel is OFF — no emitter — so this stays byte-identical).
      registry.restampSpawn(req.taskId)
    }
    // Its settle is owned by the tool layer's `.then(complete)` chain — we do
    // NOT settle it here (return a no-op settle so the caller never double-settles).
    return { registry, taskId: req.taskId, settle: () => {} }
  }
  // Foreground: register a fresh lineage record ONLY when a panel observer is
  // wired (`onSubagentEvent`). Without it, a foreground spawn keeps its historical
  // synthetic id with NO registry entry — so `registry.list()` (⇒ the LLM
  // `task_list` tool, `/agents`, `/activity`, LRU) is byte-identical when the
  // panel feature is OFF. The panel opts into foreground visibility via the sink.
  // (Background/6-tool records are registered by the tool layer regardless and
  // only get their lineage edge STAMPED above — benign for existing consumers,
  // which read depth from AgentMeta, not the record — so those stay ungated and
  // the CLI `/agents --tree` still reconstructs the background spawn tree.)
  if (parent.onSubagentEvent === undefined) return undefined
  const taskId = registry.newId()
  registry.register({
    id: taskId,
    description,
    ...(req.agentType !== undefined ? { agentType: req.agentType } : {}),
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
    depth: childDepth,
    mailboxLabel,
  })
  return {
    registry,
    taskId,
    settle: (result: SubagentResult): void => registry.complete(taskId, result),
  }
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
  const maxDepth = effectiveCap(opts.maxDepth)
  const run = opts.run ?? runAgent
  const gitProbe = opts.isGitRepo ?? isGitRepo
  const wt = opts.withWorktree ?? withWorktree
  const now = opts.now ?? Date.now
  // Multi-agent-panel SUBSTRATE — wire the shared registry's lifecycle emit sink
  // from `parent.onSubagentEvent` once (mirror of the `onAgentState` tap). No-op
  // when the sink OR the shared registry is absent (byte-identical OFF).
  installSubagentEmitter(parent)
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
    const admission = admitChildDepth(parent, maxDepth)
    if ("denied" in admission) return admission.denied
    const { childDepth } = admission

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
    // Multi-agent-panel SUBSTRATE — ensure this child has a lineage `TaskRecord`
    // in the shared registry (register foreground / stamp pre-registered
    // background) and get its OWN task id to thread as `spawnedAsTaskId`. The
    // emit (if a sink is wired) fires inside `register()`. `undefined` when no
    // shared registry ⇒ nothing registered, no id threaded (byte-identical).
    const lineage = ensureLineageTask(parent, req, childDepth, mailboxIds.agentId)
    const spawnedAsTaskId = lineage?.taskId
    // D3 (AUDIT-2026-07-14) — stamp the run id with the AUTHORITY-derived
    // `childDepth` (`childDepthOf(parent)`), NOT the caller-asserted `req.depth`
    // (a forged `req.depth:0` must not mislabel the run id; admission already used
    // the derived depth above).
    const subagentId = buildSubagentRunId(childDepth, mailboxIds.agentId, mailboxIds.spawnSeq, now)

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
      childDepth, // D3 — derived depth, not forgeable req.depth (list_agents metadata)
      req.agentType,
    )

    // ADR-0437 follow-up — mint a per-child turn gate + register a waker into
    // the host's shared `TurnWakeRegistry` under the SAME registry task id
    // `followup_task` targets, so `wake(taskId)` finds a live receiver. Absent
    // wake registry OR absent `req.taskId` ⇒ `gate` undefined + no waker
    // (byte-identical legacy / foreground path). The disposer runs in
    // `finally` so a wake on a finished child reports `no-receiver`.
    const wakerWiring = registerChildWaker(parent, req.taskId, mailboxIds.agentId)
    const turnGate = wakerWiring?.gate

    try {
      const rawChildResult = await executeChild({
        parent,
        req,
        subagentId,
        requestedCwd,
        isolate,
        mailboxIds,
        toolNamespace,
        turnGate,
        control: wakerWiring?.control,
        spawnedAsTaskId,
        run,
        withWorktree: wt,
      })

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

      // Multi-agent-panel SUBSTRATE — settle the FOREGROUND lineage record so a
      // `subagent_status{completed|failed}` transition fires (the registry maps
      // ok→completed / !ok→failed and emits, redacting the preview). No-op for a
      // background/6-tool spawn (its settle is owned by the tool layer's
      // `.then(complete)` chain) and when no shared registry is wired.
      lineage?.settle(childResult)

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
 * ADR-0437 follow-up + WS2 (RFC jul-18 §4.2) — mint a per-child
 * {@link SubagentTurnGate} + a bounded {@link ChildControlSurface} + the child
 * {@link ConversationActionSurface}, build ONE typed
 * {@link SubagentControlEndpoint} over that private state, and register it into
 * the host's shared control registry under the child's registry task id.
 *
 * Returns `undefined` when there is no wake substrate (`wake` registry absent)
 * OR no task id to key on — both cases are the byte-identical default-OFF path:
 * NO gate, NO conversation-action surface, and NO `activeTurnRef` are wired onto
 * the child (the prior child config shape), so its loop finishes immediately on
 * completion exactly as before (RFC §4.2 RED rail). When wired, the returned
 * `gate` + `control` bundle are threaded onto the child config and `dispose`
 * MUST be called when the child loop ends (unregisters the endpoint AND its
 * derived legacy waker + label, and releases any park).
 */
const registerChildWaker = (
  parent: AgentConfig,
  taskId: string | undefined,
  mailboxLabel: string,
): { gate: SubagentTurnGate; control: ChildControlWiring; dispose: () => void } | undefined => {
  const wake = parent.subagentTurnWake
  if (wake === undefined || taskId === undefined) return undefined
  const gate = new SubagentTurnGate()
  // The child's generic control queue (cancel/summarize/steer-injection seam)
  // AND its active-turn holder. The loop OWNS `.current` (writes a fresh header
  // per turn); the endpoint's steer closure only READS it. Allocated ONLY here,
  // on the wired path — the default-OFF child never gets one (byte-identical).
  const actionSurface = createConversationActionSurface()
  // The bounded typed steer-submission surface (retains deliveryId + envelope).
  const steerSurface = createChildControlSurface({
    steerConfig: { maxInputBytes: CHILD_STEER_MAX_INPUT_BYTES },
    capacity: CHILD_STEER_QUEUE_CAPACITY,
  })
  // The typed endpoint over the child's PRIVATE state. `wake("followup")` is the
  // gate's idle/busy wake (identical to the legacy waker); `interrupt()` maps
  // gate state to the closed outcome; `steer()` delegates to the bounded surface.
  const endpoint: SubagentControlEndpoint = createChildControlEndpoint({
    gate,
    surface: steerSurface,
    activeTurnRef: actionSurface.activeTurnRef,
    mailboxLabel,
    wake: (reason: string) => gate.wake(reason),
  })
  // Register the typed endpoint (superset of the legacy waker): the registry
  // derives the `followup_task`-facing waker from it and binds the mailbox label
  // so `followup_task` reaches the child's real inbox (`root/N`), not its task
  // id (BUG#4 fix). Last-writer-safe disposal.
  const unregister = wake.registerEndpoint(taskId, endpoint)
  // WS4 — thread the loop-facing steer drain view + finalization port ONLY when
  // the session steer plane exists (QUANTA_SUBAGENT_STEER on). Absent ⇒ the child
  // loop runs no post-stream safe-point drain (byte-identical default-OFF).
  const steerPlane = parent.subagent?.steerPlane
  const steerWiring =
    steerPlane !== undefined
      ? {
          childSteerDrain: {
            drainSteers: (): readonly SubagentSteerSubmission[] => steerSurface.drainSteers(),
            pendingSteers: (): number => steerSurface.pendingSteers(),
          },
          steerFinalization: steerPlane.finalization,
        }
      : {}
  return {
    gate,
    control: {
      conversationActionPort: actionSurface.port,
      activeTurnRef: actionSurface.activeTurnRef,
      steerSurface,
      ...steerWiring,
    },
    dispose: (): void => {
      unregister()
      gate.dispose()
      // WS4 (RFC §5.9) — session teardown: an accepted steer still admitted but
      // never consumed must terminate in EXACTLY ONE `cancelled` receipt (no stale
      // callback). Drain the surface and finalize each with `session_aborted`.
      // No-op when no steer plane (byte-identical) or the queue is empty.
      if (steerPlane !== undefined) {
        for (const s of steerSurface.drainSteers()) {
          steerPlane.finalization.finalizeCancelled(s.deliveryId, "session_aborted")
        }
      }
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
