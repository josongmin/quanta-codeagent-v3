/**
 * `branch_search` first-class tool (ADR-0084). Agent-level (NOT in
 * `defaultTools`) — the assembly layer registers it ONLY when
 * `AgentConfig.branchSearch` is set, mirroring `memoryTools` / subagent tools.
 *
 * Slice: `@/agent` may import `@/tool` (it is the cross-slice composer). The
 * candidate runner (`RunCandidate` bound to `runAgent`) and the isolator are
 * INJECTED by the assembly so this file stays loop-agnostic and unit-testable.
 */

import { z } from "zod"
import type { LLMPort, ModelCandidate } from "@/llm"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import type { BranchSearchAnchor } from "./anchor"
import type { RunCandidate } from "./propose"
import { makeScorer, minimalChangeSelector } from "./score"
import { runBranchSearch } from "./search"
import { buildSeeds } from "./seed"
import type {
  BranchSearchConfig,
  BranchSearchResult,
  BranchTraceEvent,
  Isolator,
  Verifier,
  VerifierKind,
} from "./types"
import {
  combineVerifiers,
  type DiagnosePort,
  lintVerifier,
  lspDiagVerifier,
  patchSizeVerifier,
  testVerifier,
  tscVerifier,
} from "./verify"

export interface BranchSearchToolDeps {
  /** The resolved `AgentConfig.branchSearch`. */
  readonly config: BranchSearchConfig
  /** Per-candidate agent run, bound to `runAgent` by the assembly. */
  readonly runCandidate: RunCandidate
  /** Build a fresh isolator for ONE search invocation (tmpdir or worktree per
   *  `config.isolation`). Bound by the assembly with the repo/src path. */
  readonly buildIsolator: () => Isolator
  /** Base model for candidates without a `modelOverride`. */
  readonly baseLlm: LLMPort
  /** Optional alternate models for mixed-model voting (ADR-0066 reuse). */
  readonly modelCandidates?: readonly ModelCandidate[]
  /** Optional diagnostics port — enables the `lsp_diag` verifier kind. */
  readonly diagnose?: DiagnosePort
  /** Optional repro-test pattern for the `test` verifier (Agentless §4). */
  readonly testPattern?: string
  /** OTel + sidecar trace sink. */
  readonly onTrace?: (e: BranchTraceEvent) => void
  /** ADR-0116 anchor seam — when wired, the orchestrator captures a Shadow
   *  ODB snapshot of the parent workspace BEFORE candidates fork, then
   *  measures per-candidate delta from that snapshot. Absent ⇒ no anchor
   *  registration, no measurement, byte-identical legacy behaviour
   *  (`delta` OMITTED on every emitted `BranchCandidate`). */
  readonly anchor?: BranchSearchAnchor
}

const inputSchema = z.object({
  task_description: z.string().min(1).describe("What the N candidates should each attempt"),
  n: z
    .number()
    .int()
    .min(2)
    .max(8)
    .optional()
    .describe("Candidate count (default: config.defaultN)"),
  // NOTE: `patch_size` is intentionally absent from this enum — it is an
  // internal / auto-wired kind appended in `execute` when an anchor is
  // present. Keeping it off the LLM-visible surface preserves a tight
  // input contract (the model picks correctness verifiers; minimal-change
  // bias is the host's opt-in via ADR-0116 / ADR-0117).
  verifier_kinds: z
    .array(z.enum(["tsc", "test", "lint", "lsp_diag"]))
    .optional()
    .describe("Verifier tier (default: config.defaultVerifierKinds)"),
})
type Input = z.infer<typeof inputSchema>

/** Build a single verifier for one kind, given deps. Returns `undefined`
 *  when the kind is unavailable (e.g. `lsp_diag` without a `diagnose` port —
 *  graceful drop, not an error). Extracted so `buildVerifier` stays a
 *  thin loop and biome cognitive-complexity doesn't trip on the switch. */
const verifierForKind = (
  k: Exclude<VerifierKind, "llm_judge">,
  deps: BranchSearchToolDeps,
): Verifier | undefined => {
  const timeoutMs = deps.config.timeoutPerBranchMs
  if (k === "tsc") return tscVerifier({ timeoutMs })
  if (k === "test")
    return testVerifier({ timeoutMs, ...(deps.testPattern ? { pattern: deps.testPattern } : {}) })
  if (k === "lint") return lintVerifier({ timeoutMs })
  if (k === "lsp_diag")
    return deps.diagnose !== undefined ? lspDiagVerifier(deps.diagnose) : undefined
  if (k === "patch_size") return patchSizeVerifier()
  return undefined
}

/** Map requested verifier kinds → concrete verifier pipeline. `lsp_diag` is
 *  silently dropped when no `diagnose` port is wired (graceful — the model
 *  shouldn't fail because the host didn't supply LSP). `patch_size` is
 *  allowed here as an INTERNAL kind (auto-appended in `execute` when an
 *  anchor is wired); `llm_judge` stays excluded (separate seam). */
const buildVerifier = (
  kinds: ReadonlyArray<Exclude<VerifierKind, "llm_judge">>,
  deps: BranchSearchToolDeps,
): Verifier => {
  const vs: Verifier[] = []
  for (const k of kinds) {
    const v = verifierForKind(k, deps)
    if (v !== undefined) vs.push(v)
  }
  // Always at least tsc — an empty pipeline would score every candidate 0.
  if (vs.length === 0) vs.push(tscVerifier({ timeoutMs: deps.config.timeoutPerBranchMs }))
  return combineVerifiers(...vs)
}

const formatWinner = (r: BranchSearchResult): string => {
  const lines = [
    `branch_search: winner ${r.winner.id} (score ${r.winnerScore.total.toFixed(2)}, ${r.allScored.length} candidates, ${r.totalWallMs}ms)`,
  ]
  for (const s of r.allScored) {
    const sig = s.score.breakdown.map((b) => `${b.kind}:${b.pass ? "✓" : "✗"}`).join(" ")
    lines.push(`  ${s.cand.id} → ${s.score.total.toFixed(2)} [${sig}] ${s.cand.outcome.kind}`)
  }
  return lines.join("\n")
}

export const branchSearchTool = (deps: BranchSearchToolDeps): Tool<Input> => ({
  name: "branch_search",
  description:
    "Run N parallel attempts at a hard edit in isolated workspaces, score each by " +
    "verifiers (tsc/test/lint), and return the winning candidate's outcome. Use when " +
    "an edit repeatedly fails tsc/tests and a single attempt isn't converging.",
  inputSchema,
  isReadOnly: () => false,
  // Each candidate forks a full agent run in its own workspace — never batch
  // this with other tool calls (it owns heavy concurrency internally).
  isConcurrencySafe: () => false,
  async *execute(input: Input, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    const n = input.n ?? deps.config.defaultN
    yield { type: "progress", message: `branch_search: spawning ${n} candidates` }

    const requested = (input.verifier_kinds ?? deps.config.defaultVerifierKinds).filter(
      (k): k is Exclude<VerifierKind, "llm_judge"> =>
        k === "tsc" || k === "test" || k === "lint" || k === "lsp_diag" || k === "patch_size",
    )
    // Auto-append `patch_size` when an anchor is wired so the per-candidate
    // delta produced by `shadowOdbAnchor` actually FLOWS into selection.
    // `patch_size` is intentionally absent from the input enum (kept off the
    // LLM surface — the model doesn't request it; it appears automatically
    // when the host opts into the anchor). Dedup preserves the original
    // ordering when callers already requested it explicitly.
    const kinds: Array<Exclude<VerifierKind, "llm_judge">> = [...requested]
    if (deps.anchor !== undefined && !kinds.includes("patch_size")) kinds.push("patch_size")
    // Default selector wraps argmax with minimal-change tiebreak: when two or
    // more candidates tie on `score.total`, prefer the smallest `delta`
    // (added+removed). Pure tiebreak — single-winner cases are unchanged.
    let result: BranchSearchResult
    try {
      result = await runBranchSearch({
        N: n,
        seeds: buildSeeds(n, deps.modelCandidates ?? []),
        baseLlm: deps.baseLlm,
        task: input.task_description,
        timeoutPerBranchMs: deps.config.timeoutPerBranchMs,
        verifier: buildVerifier(kinds, deps),
        scorer: makeScorer(deps.config.weights),
        selector: minimalChangeSelector(),
        isolator: deps.buildIsolator(),
        runCandidate: deps.runCandidate,
        ...(deps.onTrace ? { onTrace: deps.onTrace } : {}),
        ...(deps.anchor ? { anchor: deps.anchor } : {}),
      })
    } catch (e) {
      const msg = `branch_search failed: ${errMessage(e)}`
      yield {
        type: "result",
        result: {
          ok: false,
          output: msg,
          failure: { mode: "error", modelVisibleError: msg },
        },
      }
      return
    }

    yield {
      type: "result",
      result: {
        ok: result.winnerScore.total > 0,
        output: formatWinner(result),
        structured: result,
      },
    }
  },
})
