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
 * --- DEPTH SEAM (the part the main thread MUST satisfy in dispatch.ts) ---
 *
 * The `agent` tool reads the caller's recursion depth by DUCK-TYPING a numeric
 * `depth` off its {@link ToolContext} (see `src/subagent/agent-tool.ts`
 * `ctxDepth`). But `src/agent/dispatch.ts` currently builds the context as
 * `{ cwd, signal }` — there is no `depth` field on {@link ToolContext} and
 * none is ever set. So today the tool always sees depth 0 and every spawned
 * child also computes `childDepth = 1`, which makes the depth ceiling
 * un-enforceable beyond one level.
 *
 * This runner does its OWN authoritative depth check (`req.depth >
 * maxDepth ⇒ deny, never throw`) so recursion is bounded regardless. To make
 * the *tool-advertised* `maxDepth` and multi-level depth accounting correct,
 * the main thread must surface the child's depth into the ToolContext that the
 * child's dispatch builds. The exact seam (NOT implemented here — out of
 * scope) is:
 *
 *   1. Add an optional `depth?: number` to `AgentConfig` (types.ts) — the
 *      child's "I am running at depth N" marker. This runner sets it on the
 *      child config to `req.depth` (see override table below).
 *   2. In `dispatch.ts`, when building `ctx`, spread it through:
 *        const ctx: ToolContext =
 *          { cwd: config.cwd, signal: config.signal,
 *            ...(config.depth !== undefined ? { depth: config.depth } : {}) }
 *      (`ToolContext` would also gain an optional `depth?: number`, or keep
 *      the existing duck-typed read — the slice already tolerates its
 *      absence.)
 *
 * With (1)+(2) in place, a child spawned at `req.depth = N` runs `runAgent`
 * with `config.depth = N`; its dispatch puts `depth: N` on the ToolContext;
 * the `agent` tool inside it reads `N`, computes `childDepth = N+1`, and the
 * grandchild request carries `depth: N+1` — so this runner's own `req.depth >
 * maxDepth` guard and the tool's `childDepth > maxDepth` guard agree at every
 * level. Until the seam lands, only this runner's guard is authoritative
 * (still safe: recursion is bounded, just not surfaced to the tool's deny
 * message at intermediate levels).
 */

import type { Message } from "@/llm"
import { isGitRepo, withWorktree } from "@/runtime/worktree"
import { ToolRegistry } from "@/tool"
import type {
  SubagentRequest,
  SubagentResult,
  SubagentRunner,
} from "../subagent/types"
import { runAgent } from "./loop"
import type { AgentConfig, AgentOutcome } from "./types"

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
): ToolRegistry => {
  if (!toolFilter) return parent
  const allow = new Set(toolFilter)
  const kept = parent
    .specs()
    .map((s) => s.name)
    .filter((name) => allow.has(name))
    .map((name) => parent.get(name))
    .filter((t): t is NonNullable<typeof t> => t !== undefined)
  return new ToolRegistry(kept)
}

/** Chain a fresh child {@link AbortSignal} to the parent's: aborting the
 *  parent aborts the child; the child's controller is otherwise independent
 *  (the child finishing never touches the parent). If the parent is already
 *  aborted the child starts aborted too. */
const chainedSignal = (parent: AbortSignal): AbortSignal => {
  const child = new AbortController()
  if (parent.aborted) child.abort()
  else parent.addEventListener("abort", () => child.abort(), { once: true })
  return child.signal
}

/** Construct the CHILD {@link AgentConfig} by shallow-cloning `parent` and
 *  applying the subagent overrides (see the override table in the report).
 *  `store`/`hooks`/`metrics`/`run`/`sessionId`/`memory` are DROPPED so a child
 *  never persists into the parent's long-term memory or pollutes its
 *  correlation/observability; `llm`/`stream`/`permission`/`system` are kept. */
const buildChildConfig = (
  parent: AgentConfig,
  req: SubagentRequest,
  cwd: string,
): AgentConfig => {
  const seed: Message[] = [{ role: "user", content: [{ type: "text", text: req.prompt }] }]
  // Shallow clone, then strip the inheritance-unsafe keys. We rebuild the
  // object explicitly (rather than `delete`) to satisfy
  // exactOptionalPropertyTypes: omit keys entirely, never assign `undefined`.
  const child: AgentConfig = {
    llm: parent.llm,
    registry: filterRegistry(parent.registry, req.toolFilter),
    stream: parent.stream,
    permission: parent.permission,
    messages: seed,
    system: parent.system,
    cwd,
    maxTurns: req.budget?.maxTurns ?? parent.maxTurns,
    signal: chainedSignal(parent.signal),
    // Depth marker the host's dispatch seam surfaces onto ToolContext so the
    // child's own `agent` tool computes the right grandchild depth. Carried
    // duck-typed (the field is not yet on AgentConfig — see DEPTH SEAM note).
    ...({ depth: req.depth } as { depth: number }),
    // Kept (safe to share, no parent-state mutation):
    ...(parent.onConfirm ? { onConfirm: parent.onConfirm } : {}),
    ...(parent.embedder ? { embedder: parent.embedder } : {}),
    ...(parent.compaction ? { compaction: parent.compaction } : {}),
    ...(parent.planMode !== undefined ? { planMode: parent.planMode } : {}),
    // DROPPED on purpose: store, sessionId, memory, hooks, metrics, run.
    // A subagent must not write into the parent's durable memory, emit into
    // the parent's hook bus / metrics, or share its correlation context.
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
 *  - `isolation:"worktree"` + parent cwd is a git repo ⇒ run inside a
 *    throwaway worktree (`withWorktree`) with the child cwd = worktree path;
 *    not a git repo ⇒ silently fall back to no isolation (never fail);
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

  return async (req: SubagentRequest): Promise<SubagentResult> => {
    if (req.depth > maxDepth) {
      return { ok: false, finalText: "max subagent depth exceeded", turns: 0 }
    }

    const wantsWorktree = req.isolation === "worktree"
    const isolate = wantsWorktree && (await gitProbe(parent.cwd))

    if (isolate) {
      // id is sanitized by withWorktree's safeId; depth+prompt make it
      // human-traceable while staying within the worktree-name charset.
      const id = `sub-d${req.depth}-${Date.now().toString(36)}`
      const { value } = await wt(id, parent.cwd, async (worktreePath) => {
        const child = buildChildConfig(parent, req, worktreePath)
        return run(child)
      })
      return toResult(value)
    }

    // No isolation (explicit "none", missing, or worktree requested but the
    // parent cwd is not a git repo — graceful fallback, never fail).
    const child = buildChildConfig(parent, req, req.cwd ?? parent.cwd)
    return toResult(await run(child))
  }
}
