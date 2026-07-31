/**
 * REAL-FORK e2e for the adversarial-multi-voter → branch-search SELECTION fold
 * (ADR-0433 × ADR-0084).
 *
 * WHY THIS EXISTS (gap this closes):
 *   The quorum MATH is unit-covered (multi-voter-hellgate + quorum-boundary
 *   hellgate), and `multi-voter-quorum-boundary-hellgate.test.ts` battery (B)
 *   drives `runBranchSearch` with a HAND-COMPOSED verifier
 *   (`[...baseTsc, ...voterVerifier]`). That bypasses the REAL wire: it never
 *   exercises the `config.branchSearch.voterQuorum` GATE, never builds the
 *   verifier via `buildBranchSearchTool` → `deps.voterVerifierForTask`, and
 *   never folds it in through the tool's own `combineVerifiers(...)` call.
 *
 * WHAT THIS DRIVES (the real seam, end-to-end):
 *   `buildBranchSearchTool(config)`  (src/agent/branch-search-runner.ts) — the
 *   SINGLE binder that:
 *     1. GATES the voter verifier on `config.branchSearch.voterQuorum`
 *        (`buildVoterVerifierForTask`, runner :126-138) — undefined ⇒ no seam,
 *     2. builds it from the SESSION base `config.llm`
 *        (`voterQuorumVerifier`, multi-voter/signal.ts),
 *     3. injects it as `deps.voterVerifierForTask` into `branchSearchTool`,
 *   then the tool itself (`branch-search/tool.ts:174-177`) composes it via the
 *   REAL `combineVerifiers(kindVerifier, deps.voterVerifierForTask(task))`, the
 *   REAL `runBranchSearch` scores every candidate through the REAL `defaultScorer`
 *   (llm_voter_quorum weight 0.3), and the REAL `minimalChangeSelector` argmax
 *   picks the winner.
 *
 * REAL vs INJECTED (honest caveat):
 *   - REAL: the gate (`config.branchSearch.voterQuorum`), the voter build from
 *     `config.llm`, the N refute-biased voters + quorum aggregate
 *     (`runMultiVoter`), the `llm_voter_quorum` signal, the `combineVerifiers`
 *     fold, the scorer weighting, and the argmax selection — ALL production code
 *     under `buildBranchSearchTool` → `branchSearchTool.execute`.
 *   - REAL: the isolator (`tmpdir` → real `mkdtemp` + `cpSync` of a real
 *     workspace) and the base `tsc` verifier (real `runShell` → `bun run
 *     typecheck` → the workspace's `true` script, exit 0). Both candidates get
 *     an IDENTICAL tsc pass, so WITHOUT the voter fold they TIE and argmax's
 *     lexicographic tie-break picks cand-0. The voter fold is the SOLE
 *     discriminator.
 *   - INJECTED (the ONE fork boundary we stub): `runAgent` (`@/agent/loop`) is
 *     mocked to a completed outcome so a candidate does not recursively drive a
 *     full nested agent turn-loop + LLM. This mirrors the existing
 *     `branch-search-runner-hellgate.test.ts`. Everything from
 *     `bindBranchRunCandidate`'s spawn-depth authority down THROUGH the voter
 *     fold and selection is real; only the innermost agent execution is faked.
 *
 * DISCRIMINATION (non-vacuous, paired flip):
 *   Voters prefer cand-1  ⇒ cand-1 SELECTED.
 *   Flip voters to prefer cand-0 ⇒ cand-0 SELECTED.
 *   Same everything else — only the scripted voter verdicts move.
 *
 * RED-ON-INJECTION (neuter the fold at its real gate):
 *   With the SAME voters but `config.branchSearch.voterQuorum` UNSET, the runner
 *   does NOT build `voterVerifierForTask` ⇒ the tool composes the kind verifier
 *   VERBATIM ⇒ no `llm_voter_quorum` signal ⇒ tie ⇒ lexicographic cand-0. The
 *   voter-preferred candidate (cand-1) NO LONGER wins — proving the fold, not
 *   some other mechanism, is what moved selection. (This is the byte-identical
 *   default-OFF path.)
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { ToolContext, ToolResult } from "@/tool"
import { withTimeout } from "./_harness"

// ── The ONE injected boundary: the innermost per-candidate agent run. ──────────
// `bindBranchRunCandidate` (runner) calls this after routing the candidate
// through the REAL spawn-depth authority. Faking it keeps the fork cheap while
// leaving the voter fold + selection entirely real.
const forkedChildren: Array<Record<string, unknown>> = []
const { __setBranchRunAgentForTest, buildBranchSearchTool } = await import(
  "@/agent/branch-search-runner"
)

// ── A claim-aware scripted voter LLM. ──────────────────────────────────────────
// The voter verifier builds each candidate's claim as
// `Candidate ${cand.id} claims it correctly accomplished the task: ${task}`
// (multi-voter/signal.ts#candidateClaim) and hands it to the refute prompt as
// the user message. This LLM reads that prompt and votes PASS iff it mentions
// the preferred candidate id — so ALL voters pass for the preferred candidate
// and ALL fail (refute) for the other. Deterministic.
const preferCandidateLlm = (preferredNeedle: string): LLMPort => ({
  model: "voter-prefers",
  async *stream(req: StreamInput): AsyncIterable<StreamEvent> {
    const prompt = req.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
    const pass = prompt.includes(preferredNeedle)
    yield {
      type: "text_delta",
      delta: JSON.stringify({ pass, confidence: 0.95, reason: pass ? "affirmed" : "refuted" }),
    }
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

// ── A real, cheap workspace the tmpdir isolator copies per candidate. ──────────
// The base `tsc` verifier runs `bun run typecheck` in each candidate workspace;
// pointing `typecheck` at `true` makes BOTH candidates pass tsc identically via
// the REAL runShell, so ONLY the voter fold can break the tie. No `@/runtime`
// mock (which would leak a fake shell to sibling test files).
let srcDir: string
const madeDirs: string[] = []
beforeEach(() => {
  srcDir = mkdtempSync(join(tmpdir(), "mv-bs-src-"))
  madeDirs.push(srcDir)
  writeFileSync(
    join(srcDir, "package.json"),
    JSON.stringify({ name: "mv-bs-fixture", scripts: { typecheck: "true" } }),
  )
  // A trivial source file so the copy is non-empty (realistic tree).
  writeFileSync(join(srcDir, "index.ts"), "export const x = 1\n")
  forkedChildren.length = 0
  __setBranchRunAgentForTest((async (child: Record<string, unknown>) => {
    forkedChildren.push(child)
    return { reason: "completed", messages: [], turns: 3 }
  }) as never)
})
afterEach(() => __setBranchRunAgentForTest(null))
afterAll(() => {
  for (const d of madeDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

/** Minimal `AgentConfig` the runner actually reads: `branchSearch`, `llm`,
 *  `cwd`, `depth` (+ optional subagent/shadowOdb/onProgress/modelCandidates,
 *  all absent here). Cast — mirrors branch-search-runner-hellgate.test.ts —
 *  because AgentConfig has many session-only required fields the branch-search
 *  binder never touches. */
type RunnerConfig = Parameters<typeof buildBranchSearchTool>[0]
const makeConfig = (opts: {
  llm: LLMPort
  cwd: string
  voterQuorum?: { voters: number; quorum?: number }
}): RunnerConfig =>
  ({
    depth: 0,
    cwd: opts.cwd,
    llm: opts.llm,
    branchSearch: {
      defaultN: 2,
      defaultVerifierKinds: ["tsc"],
      timeoutPerBranchMs: 20_000,
      isolation: "tmpdir",
      ...(opts.voterQuorum ? { voterQuorum: opts.voterQuorum } : {}),
    },
  }) as unknown as RunnerConfig

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

/** Drive the REAL branch_search tool built by the REAL runner, and return the
 *  tool result (whose `.structured` is the `BranchSearchResult`). */
const runBranchSearchTool = async (config: RunnerConfig): Promise<ToolResult> => {
  const tool = buildBranchSearchTool(config)
  if (tool === undefined)
    throw new Error("buildBranchSearchTool returned undefined (branchSearch unset?)")
  let result: ToolResult | undefined
  const cwd = (config as unknown as { cwd: string }).cwd
  for await (const ev of tool.execute(
    { task_description: "repair the failing edit", n: 2 },
    ctx(cwd),
  )) {
    if (ev.type === "result") result = ev.result
  }
  if (result === undefined) throw new Error("branch_search yielded no result")
  return result
}

/** Extract the `BranchSearchResult` off the structured tool result. */
interface ScoredEntry {
  cand: { id: string }
  score: {
    total: number
    breakdown: ReadonlyArray<{ kind: string; pass: boolean; magnitude?: number }>
  }
}
interface BSResult {
  winner: { id: string }
  winnerScore: { total: number }
  allScored: ReadonlyArray<ScoredEntry>
}
const structured = (r: ToolResult): BSResult => {
  const s = (r as { structured?: unknown }).structured
  if (s === undefined) throw new Error(`no structured result; output=${r.output}`)
  return s as BSResult
}
const totalById = (bs: BSResult): Map<string, number> =>
  new Map(bs.allScored.map((e) => [e.cand.id, e.score.total]))

const TIMEOUT_MS = 40_000

describe("ADR-0433 × ADR-0084 REAL branch_search — voter quorum drives SELECTION", () => {
  test(
    "voters prefer cand-1 ⇒ cand-1 SELECTED (fold beats the tsc tie)",
    async () => {
      const config = makeConfig({
        llm: preferCandidateLlm("Candidate cand-1"),
        cwd: srcDir,
        voterQuorum: { voters: 3 },
      })
      const r = await withTimeout(runBranchSearchTool(config), TIMEOUT_MS, "branch_search prefer-1")
      const bs = structured(r)

      // Selection followed the quorum.
      expect(bs.winner.id).toBe("cand-1")

      // The fork is real down to the injected runAgent boundary: exactly N=2
      // candidates were forked (the voter fold is NOT short-circuiting the run).
      expect(forkedChildren).toHaveLength(2)

      // The FOLD is load-bearing — pin the arithmetic, not just the outcome.
      // Both candidates pass tsc (weight 0.4). cand-1's 3/3 voters pass ⇒
      // llm_voter_quorum pass, magnitude 1 (weight 0.3):
      //   reward = (0.4*1 + 0.3*1)/(0.4+0.3) = 1.0
      // cand-0's voters all refute ⇒ pass:false, magnitude 0:
      //   reward = (0.4*1 + 0.3*0)/(0.4+0.3) = 0.4/0.7 ≈ 0.5714
      const totals = totalById(bs)
      expect(totals.get("cand-1")).toBeCloseTo(1, 10)
      expect(totals.get("cand-0")).toBeCloseTo(0.4 / 0.7, 10)
      expect(totals.get("cand-1")).toBeGreaterThan(totals.get("cand-0") as number)

      // The voter signal is REALLY present in the winner's breakdown (proves the
      // combineVerifiers fold ran, not that some other signal won).
      const winnerEntry = bs.allScored.find((e) => e.cand.id === "cand-1")
      const voterSig = winnerEntry?.score.breakdown.find((b) => b.kind === "llm_voter_quorum")
      expect(voterSig).toBeDefined()
      expect(voterSig?.pass).toBe(true)
      expect(voterSig?.magnitude).toBeCloseTo(1, 10)
    },
    TIMEOUT_MS,
  )

  test(
    "FLIP: voters prefer cand-0 ⇒ selection FLIPS to cand-0 (same everything else)",
    async () => {
      const config = makeConfig({
        llm: preferCandidateLlm("Candidate cand-0"),
        cwd: srcDir,
        voterQuorum: { voters: 3 },
      })
      const r = await withTimeout(runBranchSearchTool(config), TIMEOUT_MS, "branch_search prefer-0")
      const bs = structured(r)

      expect(bs.winner.id).toBe("cand-0")
      const totals = totalById(bs)
      expect(totals.get("cand-0")).toBeCloseTo(1, 10)
      expect(totals.get("cand-1")).toBeCloseTo(0.4 / 0.7, 10)
      expect(totals.get("cand-0")).toBeGreaterThan(totals.get("cand-1") as number)

      const winnerEntry = bs.allScored.find((e) => e.cand.id === "cand-0")
      const voterSig = winnerEntry?.score.breakdown.find((b) => b.kind === "llm_voter_quorum")
      expect(voterSig?.pass).toBe(true)
      expect(voterSig?.magnitude).toBeCloseTo(1, 10)
    },
    TIMEOUT_MS,
  )

  test(
    "RED-ON-INJECTION: voterQuorum UNSET neuters the fold ⇒ NO voter signal, scores EQUAL " +
      "(voter preference exerts zero score influence)",
    async () => {
      // SAME voters that WOULD prefer cand-1 in the ON case, but the gate is OFF.
      // The runner never builds voterVerifierForTask; the tool composes the kind
      // verifier VERBATIM, so NO llm_voter_quorum signal exists.
      //
      // We assert the fold's NEUTERING deterministically (NOT via the winner id):
      // the real `tsc` verifier's `durationMs` is live wall-clock, and
      // `argmaxSelector`'s SECOND tiebreak is `totalMs ↑` — so the faster
      // candidate wins a genuine tie non-deterministically. That duration
      // tiebreak is quorum-INDEPENDENT, which is exactly the point: with the
      // fold neutered, selection is decided by something OTHER than the voter
      // quorum. The load-bearing, deterministic proof is:
      //   (a) NO candidate carries an llm_voter_quorum signal (fold did not run),
      //   (b) both candidates' `total` are EQUAL (the voter preference moved the
      //       score by zero) — contrast the ON case where cand-1's total (1.0)
      //       STRICTLY exceeds cand-0's (0.4/0.7). If the fold leaked into the
      //       OFF path (bug), cand-1's total would rise above cand-0's here and
      //       (b) would go RED.
      const config = makeConfig({
        llm: preferCandidateLlm("Candidate cand-1"),
        cwd: srcDir,
        // voterQuorum intentionally OMITTED (default-OFF).
      })
      const r = await withTimeout(
        runBranchSearchTool(config),
        TIMEOUT_MS,
        "branch_search no-quorum",
      )
      const bs = structured(r)

      // (a) No candidate carries a voter signal — the fold did not run.
      for (const e of bs.allScored) {
        expect(e.score.breakdown.some((b) => b.kind === "llm_voter_quorum")).toBe(false)
        // tsc-only ⇒ reward = (0.4*1)/0.4 = 1 for both (byte-identical default-OFF).
        expect(e.score.total).toBeCloseTo(1, 10)
      }

      // (b) The voter preference exerted ZERO influence: the two totals are
      // EQUAL. In the ON case (voters prefer cand-1) the totals are 1.0 vs
      // 0.4/0.7 — a strict gap. Here they coincide, so nothing quorum-shaped is
      // discriminating the candidates.
      const totals = totalById(bs)
      expect(totals.get("cand-0")).toBe(totals.get("cand-1"))
    },
    TIMEOUT_MS,
  )
})
