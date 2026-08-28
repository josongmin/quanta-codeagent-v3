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
// `runAgent` is a process-wide module export. Test files that mock that module
// leak their fake into unrelated loop consumers when Bun reuses a worker. Keep
// the sole fork boundary locally swappable instead; the test setup resets this
// slot after every case. Do not initialize this with `runAgent`: this module is
// in a tolerated loop → features → runner → loop cycle, so the imported binding
// can still be in its TDZ during module initialization.
// The cell moved to `./branch-search-runner/run-agent-override`, a LEAF with no
// value imports. `tests/setup.ts` (a bunfig preload) needs the setter before
// every test file in the repo, and reaching it through this module dragged
// `@/agent/loop` → `@/agent/session-resources` → `@/tool` — 284 files under
// `src/tool` — into the preload's runtime closure. Re-exported here so existing
// callers are unchanged.
import { branchRunAgentOverride } from "./branch-search-runner/run-agent-override"
import { runAgent } from "./loop"
import { voterQuorumVerifier } from "./multi-voter"
import { canAdmitChildDepth, childDepthOf, effectiveCap, SpawnLineageError } from "./spawn-depth"
import type { AgentConfig } from "./types"

export { __setBranchRunAgentForTest } from "./branch-search-runner/run-agent-override"

/** Build a candidate-scoped `runAgent` fork. Each candidate runs in its own
 *  isolated workspace at depth+1 with the seed's model/promptHint applied, and
 *  with `branchSearch` STRIPPED so a candidate can never recursively fan out
 *  (negative invariant — prevents N^depth explosion).
 *
 *  D1 (AUDIT-2026-07-14) — the candidate fork is a SPAWN VECTOR and must obey the
 *  SAME spawn-depth authority as every other vector (subagent-runner reject).
 *  Before forking, the candidate's derived child depth (`childDepthOf(config)` —
 *  the SSOT lineage math, NOT a re-implemented `+1`) is checked against the
 *  `effectiveCap`. When the cap forbids it (e.g. `QUANTA_MAX_DESCENDANT_DEPTH=0`
 *  kill switch ⇒ `canAdmitChildDepth(1, 0)` false) OR the parent depth is malformed
 *  (`SpawnLineageError`), the candidate is DENIED as a failed outcome (mirroring the
 *  runner reject — NO throw into the propose loop; the failed candidate folds to
 *  score 0 and never wins). At the root under default cap 1, `canAdmitChildDepth(1,1)`
 *  is true ⇒ candidates fork exactly as before (byte-identical). */
export const bindBranchRunCandidate = (config: AgentConfig): RunCandidate => {
  // Strip `branchSearch` once (exactOptionalPropertyTypes: omit, never set
  // `undefined`). Reused for every candidate fork.
  const { branchSearch: _stripped, ...parentSansBranch } = config
  return async ({ workspace, seed, task, baseLlm, signal }) => {
    // D1 — route the candidate depth through the AUTHORITY before forking.
    let childDepth: number
    try {
      childDepth = childDepthOf(config)
    } catch (e) {
      if (e instanceof SpawnLineageError) {
        return { kind: "failed", reason: `branch_search denied: ${e.message}` }
      }
      throw e
    }
    const cap = effectiveCap(config.subagent?.maxDepth)
    if (!canAdmitChildDepth(childDepth, cap)) {
      return {
        kind: "failed",
        reason: `branch_search denied: child depth ${childDepth} exceeds cap ${cap}`,
      }
    }
    const llm = seed.modelOverride?.port ?? baseLlm
    const hint = seed.promptHint ? `\n\n<branch-hint>${seed.promptHint}</branch-hint>` : ""
    // SECURITY: the candidate inherits the parent's `ownershipPolicy` VERBATIM via
    // the spread — the same fence binds the candidate as the parent (candidates
    // carry NO per-candidate owned/forbidden input, so this IS the correct
    // narrowing: `narrowChildOwnership(parent, undefined) === parent`). This path
    // deliberately does NOT enter `buildChildConfig`. INVARIANT: branch_search must
    // never gain a per-candidate surface input WITHOUT routing through
    // `narrowChildOwnership` — pinned by branch-search-ownership-inherit-hellgate.
    const child: AgentConfig = {
      ...parentSansBranch,
      llm,
      cwd: workspace,
      signal,
      depth: childDepth,
      messages: [{ role: "user", content: [{ type: "text", text: `${task}${hint}` }] }],
    }
    const outcome = await (branchRunAgentOverride() ?? runAgent)(child)
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
