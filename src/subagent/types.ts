/**
 * Subagent slice — public seams.
 *
 * SLICE ISOLATION: this slice must NOT import `@/agent`. The recursive
 * agent-loop runner is *injected* as {@link SubagentRunner}. The main thread
 * satisfies the port later by forking `runAgent` (depth+1, filtered registry,
 * its own working memory). Nothing here knows about that implementation.
 */

/** Per-request token/turn ceiling threaded down into a forked agent loop. */
export interface TaskBudget {
  /** Max model turns the child loop may take. */
  maxTurns?: number
  /** Max tokens the child loop may consume (provider-counted). */
  maxTokens?: number
}

export interface SubagentRequest {
  /** The task prompt handed to the child agent. */
  prompt: string
  /** Named subagent profile (e.g. "Explore", "Plan"). Absent ⇒ fork/general. */
  agentType?: string
  /** Tool-name allowlist the child registry is filtered to. Absent ⇒ inherit. */
  toolFilter?: string[]
  /** "worktree" ⇒ run the child in an isolated git worktree. */
  isolation?: "none" | "worktree"
  /** Recursion depth of this child (parent depth + 1). Root is 0. */
  depth: number
  /** Optional token/turn budget passthrough for the forked loop. */
  budget?: TaskBudget
  /** Working directory the child should run in (worktree path when isolated). */
  cwd?: string
}

export interface SubagentResult {
  ok: boolean
  /** Final assistant text the child produced (the answer to summarize). */
  finalText: string
  /** Number of model turns the child took. */
  turns: number
  /** Optional raw transcript for callers that want the full trace. */
  messages?: unknown[]
}

/**
 * The injected port. The main thread provides the real implementation (a
 * forked `runAgent`). Everything in this slice depends only on this signature.
 */
export type SubagentRunner = (req: SubagentRequest) => Promise<SubagentResult>
