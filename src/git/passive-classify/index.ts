/**
 * H6 (jun-3-misc §3) — Passive git/gh stdout → structured VCS event slice.
 *
 * Closes the raw-stdout blind spot: `src/git/directive-emit/` only reads
 * quanta's OWN emitted `::git-*` lines, so a raw `git rebase/merge/cherry-pick`
 * or `gh pr create` the agent (or user) runs through the `bash` tool produced
 * NO observability. This slice classifies that output into the SAME structured
 * shape an explicit directive would carry and routes it onto the existing
 * turn-diff event bus (the bash hook calls a wired sink; the host adapts the
 * sink onto the `AgentEvent` stream — no second bus).
 *
 * Slice isolation: imports only `@/shared` (for the runtime knob). Does NOT
 * import `@/tool` / `@/agent` / `@/llm` — the bash hook reads its sink via a
 * duck-typed `ToolContext` view (see `./bash-hook`).
 *
 * Default-OFF: knob `QUANTA_PASSIVE_VCS` (runtime-config) + `noopVcsEventSink`.
 */

export { maybeEmitPassiveVcs, type PassiveVcsHookCtx } from "./bash-hook"
export { classifyPassiveVcs } from "./classifier"
export { type GhPrCommand, parseGhPrCommand } from "./pr-action"
export { noopVcsEventSink, type PassiveVcsEventSink } from "./sink"
export type {
  PassiveVcsInput,
  VcsBranch,
  VcsBranchAction,
  VcsCommit,
  VcsCommitKind,
  VcsEvent,
  VcsPr,
  VcsPrAction,
  VcsPush,
} from "./types"
