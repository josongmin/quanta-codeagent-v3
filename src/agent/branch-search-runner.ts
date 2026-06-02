/**
 * Loop-coupling binder for speculative branch search (ADR-0084) — the SINGLE
 * file that joins the loop-agnostic `@/agent/branch-search` slice to the real
 * `runAgent` + isolation strategy. Mirrors `subagent-runner.ts`'s role: keep
 * the `branch-search/` core pure + unit-testable (all ports), confine the
 * `runAgent` fork + `@/runtime` isolator choice to one place.
 *
 * The `loop → features → branch-search-runner → loop` import cycle is
 * tolerated exactly as `loop → features → subagent-runner → loop` is:
 * `runAgent` is only CALLED at runtime, never at module-init.
 */

import type { Tool } from "@/tool"
import {
  type BranchSearchAnchor,
  type BranchTraceEvent,
  branchSearchTool,
  formatBranchTrace,
  type Isolator,
  type RunCandidate,
  shadowOdbAnchor,
  tmpdirIsolator,
  type Verifier,
  worktreeIsolator,
} from "./branch-search"
import { runAgent } from "./loop"
import { voterQuorumVerifier } from "./multi-voter"
import type { AgentConfig } from "./types"

/** Build a candidate-scoped `runAgent` fork. Each candidate runs in its own
 *  isolated workspace at depth+1 with the seed's model/promptHint applied, and
 *  with `branchSearch` STRIPPED so a candidate can never recursively fan out
 *  (negative invariant — prevents N^depth explosion). */
export const bindBranchRunCandidate = (config: AgentConfig): RunCandidate => {
  // Strip `branchSearch` once (exactOptionalPropertyTypes: omit, never set
  // `undefined`). Reused for every candidate fork.
  const { branchSearch: _stripped, ...parentSansBranch } = config
  return async ({ workspace, seed, task, baseLlm, signal }) => {
    const llm = seed.modelOverride?.port ?? baseLlm
    const hint = seed.promptHint ? `\n\n<branch-hint>${seed.promptHint}</branch-hint>` : ""
    const child: AgentConfig = {
      ...parentSansBranch,
      llm,
      cwd: workspace,
      signal,
      depth: (config.depth ?? 0) + 1,
      messages: [{ role: "user", content: [{ type: "text", text: `${task}${hint}` }] }],
    }
    const outcome = await runAgent(child)
    return { kind: "completed", turns: outcome.turns }
  }
}

/** Pick the isolation strategy from `config.branchSearch.isolation`, rooted at
 *  the parent `cwd`. Default `tmpdir` (git-free); `worktree` for big repos. */
export const buildBranchIsolator = (config: AgentConfig): Isolator =>
  config.branchSearch?.isolation === "worktree"
    ? worktreeIsolator({ repoRoot: config.cwd })
    : tmpdirIsolator({ srcDir: config.cwd })

/** ADR-0116 — build the optional `BranchSearchAnchor` for a session. Returns
 *  `undefined` when `AgentConfig.shadowOdb` is unset (default-OFF: anchor not
 *  threaded into the tool, branch-search emits candidates with `delta`
 *  OMITTED — byte-identical to pre-ADR-0116). When set, anchors at the
 *  PARENT cwd (NOT the candidate workspace — the candidates fork FROM here). */
const buildBranchSearchAnchor = (config: AgentConfig): BranchSearchAnchor | undefined => {
  if (config.shadowOdb === undefined) return undefined
  return shadowOdbAnchor(config.shadowOdb, config.cwd)
}

/** ADR-0117 — when `config.onProgress` is wired, build an `onTrace` adapter
 *  that formats each event and fans it out to the host's progress callback.
 *  Absent ⇒ returns `undefined` so the tool's `onTrace` slot stays unset
 *  (byte-identical to pre-ADR-0117). A throwing host callback is swallowed
 *  per-event (matches the OTel sink contract — observability must never
 *  fail the search). */
const buildBranchProgressTrace = (
  config: AgentConfig,
): ((e: BranchTraceEvent) => void) | undefined => {
  const onProgress = config.onProgress
  if (onProgress === undefined) return undefined
  return (event: BranchTraceEvent) => {
    try {
      onProgress(formatBranchTrace(event))
    } catch {
      /* host progress callback must never break the search */
    }
  }
}

/** ADR-0433 — when `config.branchSearch.voterQuorum` is set, build the per-task
 *  factory that produces an adversarial-multi-voter `Verifier` from the session
 *  base `LLMPort`. Each candidate then gets ONE additive `llm_voter_quorum`
 *  signal. Returns `undefined` when unset (default-OFF: no voter verifier wired,
 *  byte-identical scoring). The branch-search slice never imports
 *  `@/agent/multi-voter`; this binder joins the two slices. */
const buildVoterVerifierForTask = (
  config: AgentConfig,
): ((task: string) => Verifier) | undefined => {
  const vq = config.branchSearch?.voterQuorum
  if (vq === undefined) return undefined
  return (task: string) =>
    voterQuorumVerifier({
      llm: config.llm,
      task,
      voters: vq.voters,
      ...(vq.quorum !== undefined ? { quorum: vq.quorum } : {}),
    })
}

/** Construct the `branch_search` tool for a session, or `undefined` when
 *  `config.branchSearch` is unset (default-OFF — caller skips registration).
 *  `buildSessionFeatures` pushes the returned tool into `extraTools`. */
export const buildBranchSearchTool = (config: AgentConfig): Tool | undefined => {
  const bs = config.branchSearch
  if (bs === undefined) return undefined
  const anchor = buildBranchSearchAnchor(config)
  const onTrace = buildBranchProgressTrace(config)
  const voterVerifierForTask = buildVoterVerifierForTask(config)
  return branchSearchTool({
    config: bs,
    runCandidate: bindBranchRunCandidate(config),
    buildIsolator: () => buildBranchIsolator(config),
    baseLlm: config.llm,
    ...(config.modelCandidates ? { modelCandidates: config.modelCandidates } : {}),
    ...(anchor ? { anchor } : {}),
    ...(onTrace ? { onTrace } : {}),
    ...(voterVerifierForTask ? { voterVerifierForTask } : {}),
  }) as Tool
}
