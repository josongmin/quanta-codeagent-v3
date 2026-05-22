# ADR-0084: Speculative branch search — N-best verifier-prover

- **Status**: Accepted (default-OFF seam; byte-identical when `AgentConfig.branchSearch` absent)
- **Date**: 2026-05-22
- **Related**: ADR-0011 (subagent runner), ADR-0015 (LSP nav for diagnostics), ADR-0027 (apply_patch V4A), ADR-0066 (model-swap retry — `ModelCandidate`), ADR-0074 (OTel span tree), ADR-0076 (verify-guard), Agentless (Princeton 2024 — §3 patch sampling, §4 reproduction-test selection), [[worktree-node-modules-hazard]].

## Context

The agent loop is **linear**: one trajectory per turn. On a hard edit, the model gets a single attempt; verify-guard's same-turn retry re-prompts the SAME model with the SAME context — bounded stochasticity. Academic SWE-bench leaders (Agentless §3/§4) instead **sample N candidate patches in parallel, score with fast verifiers, pick by argmax** — every quoted leader does this; v3 had nothing comparable.

No commercial coding agent ships this in its MAIN loop: Cursor's Bug Bot runs parallel sandboxes only for the dedicated bug-bot UX; Codex `spawn_agent` and Claude Code's Task are sequential delegation. Adopting it inside `apps/agent` puts us ahead of commercial parallels while composing with RFC may-22 mode-bounded config (per-mode opt-in).

## Decision

A new `@/agent/branch-search/` slice with a CLOSED-port architecture:

```ts
runBranchSearch({
  N, seeds, baseLlm, task, timeoutPerBranchMs,
  verifier,   // Verifier port — combineVerifiers(tsc, test, lint, lsp_diag)
  scorer,     // Scorer port — pure 0..1 weighted fold
  selector,   // Selector port — pure argmax + tie-break
  isolator,   // Isolator port — tmpdir | worktree, node_modules-hazard-guarded
  runCandidate, // RunCandidate port — bound to runAgent by the assembly
  onTrace,
}): Promise<{ winner, winnerScore, allScored, totalWallMs }>
```

A first-class `branch_search` tool (built by `branchSearchTool(deps)`, agent-level — NOT in `defaultTools`) exposes this to the model. Per-mode wiring lives in `apps/agent/mode-presets/<mode>.ts` against `AgentConfig.branchSearch?: BranchSearchConfig`.

### Five invariants

1. **Default-OFF**: `AgentConfig.branchSearch === undefined` ⇒ tool unregistered, byte-identical legacy single-trajectory path.
2. **Closed kinds**: `VerifierKind = tsc | test | lint | lsp_diag | patch_size | llm_judge`. Adding a kind is a compile error at the scorer.
3. **Losers preserved**: every scored candidate surfaces via `onTrace` (OTel + smoke `losers.jsonl`). Tier-0 smoke replays the WINNER only — non-determinism stays out of the deterministic gate.
4. **Per-candidate isolation**: each candidate's `runAgent` runs against an `Isolator`-produced workspace; the node_modules self-symlink hazard ([[worktree-node-modules-hazard]]) is guarded — cleanup `unlink`s the symlink (link only) BEFORE `rm -rf`.
5. **Cost dimension**: per-mode `N` (cli=3, bench=5, ci-bot=DISABLED, daemon=3). Hard cap `N ≤ 8` (Agentless §6 plateau).

## Agentless techniques absorbed

1. **Temperature diversification** (§3.1): `buildSeeds(N)` spreads `[0.2 .. 1.0]`.
2. **Syntactic pre-filter** (§3.2): a candidate whose run failed never reaches the verifier pipeline (scored 0 directly).
3. **Reproduction-test selection** (§4): `testVerifier({pattern})` runs ONLY the repro test.
4. **Mixed-model voting** (§4.2): seeds carry `modelOverride: ModelCandidate` (ADR-0066 reuse).

## Mode-preset wiring

| Mode | slot | N | Verifiers | Rationale |
|---|---|---|---|---|
| cli | enabled | 3 | tsc + lint | Interactive budget |
| bench | enabled | 5 | tsc + test + lint | Score-maximizing |
| ci-bot | **disabled** | — | — | Unattended N-best landing a wrong winner is dangerous |
| daemon | enabled (per task) | 3 | tsc + lint + lsp_diag | Diagnostic-rich; trace stored for next-day review |

## Alternatives rejected

- **Tree search (Moatless)**: too expensive for interactive budgets.
- **Reflection-only (verify-guard same-turn retry)**: insufficient stochasticity.
- **One-prompt "give N alternatives"**: model conflates; verifier can't score independently.
- **Devin-style supervisor**: complexity disproportionate; the N-best primitive composes with the existing single-agent loop.

## Consequences

- **Forward**: `branch_search` is the model's lever for hard edits; OTel `branch.candidate.id`/`branch.score.total` spans give cost-per-edit; the loser sidecar feeds a future diversity-vs-score eval.
- **Cost**: opt-in per-mode ⇒ no surprise N-fan-out.
- **Composes** with model-swap (ADR-0066 mixed models), apply_patch (ADR-0027 winner diff), verify-guard (ADR-0076 future auto-trigger on N-fail).

## Negative invariants

- `runBranchSearch` MUST NOT execute any candidate against the parent workspace — every dispatch via `isolator.acquire(i)`.
- `Verifier` impls MUST NOT mutate the workspace (read-only analysis).
- A timeout/abort on ONE candidate MUST NOT cancel others (`Promise.allSettled`).
- The `branch_search` tool MUST refuse cleanly (ok:false) when `AgentConfig.branchSearch` is absent — no default fallback.
- Tier-0 smoke replays the winner ONLY.

## Status of implementation (2026-05-22)

Slice complete + 24 unit tests (score/select/seed/combineVerifiers/parallelPropose/runBranchSearch with injected fakes — hermetic). **Assembly registration deferred**: binding `runCandidate → runAgent`, `buildIsolator`, and the `mode-preset` `branchSearch` slots lands in `apps/agent` (currently in-flight). Until then the slice is dormant (default-OFF) — importable but unregistered.
