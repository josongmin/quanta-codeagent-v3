/**
 * Tool-name matcher primitives (Tier-0 absorption #0-1, AWF 2-matcher pattern
 * from Claude Desktop 1.7196.3 build). Used by {@link HookBus.on} to gate a
 * PreToolUse / PostToolUse handler on a tool-name subset, so a host can wire
 * one handler for filesystem-touching tools and a SEPARATE handler for the
 * agent-spawning / sub-task tools, without per-call pattern checks in user
 * code.
 *
 * Slice discipline: pure leaf module. No imports from any other slice.
 *
 * The matcher is a small structural union — every shape can be evaluated in
 * O(1) (string equality, set membership) or O(name.length) (regex). There is
 * no fuzzy / heuristic fallback by design: a host that wants "anything
 * starting with read_" passes a RegExp, NOT a magic prefix string.
 */

export type ToolMatcher = string | readonly string[] | RegExp | ((name: string) => boolean)

/** Canonical matcher for filesystem-touching tools. AWF group: the same set
 *  Claude Desktop pins to the FS PreToolUse hook channel. */
export const FS_TOOLS_MATCHER: readonly string[] = [
  "read",
  "write",
  "edit",
  "multi_edit",
  "notebook_edit",
  "grep",
  "glob",
] as const

/** Canonical matcher for agent-spawning / orchestration tools. AWF's second
 *  channel — separate from FS so a host can apply distinct audit / deny
 *  policies to "child invocations" vs "file mutations". */
export const AGENT_TOOLS_MATCHER: readonly string[] = [
  "agent",
  "task",
  "task_output",
  "task_stop",
] as const

/** Evaluate a matcher against a tool name. An absent matcher is the "match
 *  everything" identity — preserving byte-identical semantics for legacy
 *  callers that registered without an `options.matcher`.
 *
 *  Hardening: a function-shaped matcher that THROWS is treated as a no-match
 *  (returns `false`) rather than propagating. Without this, a single buggy
 *  matcher closure poisons the entire `pre_tool_use` emit — the throw escapes
 *  `runHandler`'s try/catch (matchTool is called BEFORE `runHandler`), bubbles
 *  through `runAdmissibilityGate`, and is normalized as a generic dispatch
 *  error by dispatchTool. That silently disables every other (correct) hook
 *  on the call and swallows the per-handler isolation guarantee. Returning
 *  `false` keeps the rest of the chain firing. */
export const matchTool = (matcher: ToolMatcher | undefined, name: string): boolean => {
  if (matcher === undefined) return true
  if (typeof matcher === "string") return matcher === name
  if (Array.isArray(matcher)) return matcher.includes(name)
  if (matcher instanceof RegExp) return matcher.test(name)
  if (typeof matcher === "function") {
    try {
      return Boolean(matcher(name))
    } catch {
      return false
    }
  }
  return false
}
