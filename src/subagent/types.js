/**
 * Subagent slice — public seams.
 *
 * SLICE ISOLATION: this slice must NOT import `@/agent`. The recursive
 * agent-loop runner is *injected* as {@link SubagentRunner}. The main thread
 * satisfies the port later by forking `runAgent` (depth+1, filtered registry,
 * its own working memory). Nothing here knows about that implementation.
 */
export {};
