# ADR-0083: Speculative branch search — N-best verifier-prover

- **Status**: Accepted (default-OFF seam; byte-identical when `AgentConfig.branchSearch` absent)
- **Date**: 2026-05-22
- **Related**: ADR-0011 (subagent runner), ADR-0015 (LSP nav for diagnostics), ADR-0027 (apply_patch V4A), ADR-0066 (model-swap retry — provides `ModelCandidate`), ADR-0074 (OTel span tree), ADR-0076 (loop branch hardening — verify-guard), Agentless (Princeton 2024, §3 patch sampling + §4 reproduction test selection).

## Context

The agent loop is **linear**: one trajectory per turn. On a hard edit (cross-file refactor, subtle bug fix), the model gets a single attempt; if `tsc`/`test`/`lint` fail, the loop relies on verify-guard's same-turn retry, which re-prompts the SAME model with the SAME context — divergence is bounded by the model's stochasticity at the same temperature.

The SOTA pattern in academic SWE-bench leaders (Agentless §3 / §4, AutoCodeRover ensemble) is to **sample N=3-40 candidate patches in parallel, score them with fast verifiers (compile/test/lint), and pick by argmax**. v3 has not had this — every quoted SWE-bench leader does.

Commercial coding agents have NOT shipped this in their main loop:
- Cursor's "Bug Bot" runs parallel sandboxes but only for the dedicated bug-bot UX, not Composer.
- Codex's `spawn_agent` is sequential delegation.
- Claude Code's Task tool is single-thread delegation.

Adopting it inside `apps/agent` puts us ahead of commercial parallels while staying composable with the RFC may-22 mode-bounded config (per-mode opt-in: cli/bench yes, ci-bot no).

## Decision

A new sibling slice `@/agent/branch-search/` exposes a CLOSED-port architecture:

```ts
runBranchSearch({
  N, seeds, baseLlm, task, timeoutPerBranchMs,
  verifier,   // Verifier port — composes tsc + test + lint + lsp_diag + llm_judge
  scorer,     // Scorer port — pure 0..1 fold of signals
  selector,   // Selector port — pure argmax + tie-break
  isolator,   // Isolator port — withWorktree by default, mkdtemp for tests
  onTrace,    // OTel + smoke loser-sidecar sink
}): Promise<{ winner, winnerScore, allScored }>
```

A first-class `branch_search` tool exposes this to the model. The model calls it on hard edits ("3 attempts at this refactor, return the winner's diff"). Per-mode wiring lives in `apps/agent/mode-presets/<mode>.ts` against the `AgentConfig.branchSearch?: BranchSearchConfig` opt-in.

### Five invariants

1. **Default-OFF**: `AgentConfig.branchSearch === undefined` ⇒ tool unregistered, byte-identical legacy single-trajectory path. Verified by snapshot tests on the dispatch + tool surface.
2. **Closed kinds**: `VerifierKind = "tsc" | "test" | "lint" | "lsp_diag" | "patch_size" | "llm_judge"`. Adding a kind becomes a compile error at the scorer (exhaustive `never`).
3. **Losers preserved**: every scored candidate is surfaced via `onTrace`; the smoke fixture's `losers.jsonl` sidecar archives them. Tier-0 smoke replays the WINNER only — non-determinism stays out of the deterministic gate.
4. **Per-candidate isolation**: each candidate runs `runAgent` against an isolated `cwd` produced by the `Isolator` port. Default impl uses `@/runtime/worktree-fork#withWorktree`; the `node_modules` self-symlink hazard ([[worktree-node-modules-hazard]]) is avoided — `cp -r` or fresh worktree, never symlink.
5. **Cost dimension**: per-mode default `N` (cli=3, bench=5, ci-bot=DISABLED, daemon=3 opt-in). Hard cap `N ≤ 8` at the orchestrator (Agentless §6: diversity plateaus above N=10, latency dominates).

## Agentless techniques absorbed (verbatim acknowledgement)

1. **Temperature diversification** (Agentless §3.1): seeds carry `temperature` overrides; `buildSeeds(N)` defaults to `[0.2, 0.5, 0.8, ...]`.
2. **Syntactic pre-filter** (Agentless §3.2): a candidate whose proposed patch fails AST parse is short-circuited to score 0 before invoking the verifier pipeline.
3. **Reproduction-test selection** (Agentless §4): `testVerifier` accepts a `pattern` arg derived from the failing test's name — we run ONLY that test, not the whole suite (~10x faster).
4. **Mixed-model voting** (Agentless §4.2): seeds may carry `modelOverride: ModelCandidate` so the candidate set spans multiple providers — leverages ADR-0066's existing `modelCandidates` slot.

## Mode-preset wiring

| Mode | `branchSearch` slot | Default N | Verifiers | Rationale |
|---|---|---|---|---|
| `cli` | enabled | 3 | tsc + lint | Interactive budget — 3 candidates × ~10s tsc each ≈ 30s, acceptable for hard edits |
| `bench` | enabled | 5 | tsc + test + lint | Score-maximizing — bench cares about correctness over latency |
| `ci-bot` | **disabled** | — | — | N-best decisions in unattended CI are dangerous: a wrong "winner" lands unreviewed. Restrict to human-in-the-loop modes. |
| `daemon` | enabled (per task) | 3 | tsc + lint + lsp_diag | Nightly batch — diagnostic-rich verifiers; persistent state stores trace for next-day human review |

## Alternatives rejected

- **Tree search (Moatless)**: full tree expand is too expensive for our interactive budgets; N-best with verifier shortcut wins on $/improvement.
- **Reflection-only (current verify-guard same-turn retry)**: stochasticity insufficient — same model, same context, near-identical attempts.
- **Single-shot ensemble via one prompt asking for N alternatives**: model conflates the alternatives; verifier cannot score them independently.
- **Build a custom Devin-style multi-agent supervisor**: complexity disproportionate; the N-best primitive composes naturally with the existing single-agent loop.

## Consequences

- **Forward**: `branch_search` tool is the model's lever for hard edits; OTel `branch.candidate.id` / `branch.score.total` / `branch.verifier.kind` spans give cost-per-edit metrics; the `losers.jsonl` smoke sidecar lets a future eval track diversity vs. score.
- **Cost**: opt-in mode-preset ⇒ no surprise N-fan-out cost. `daemon` mode logs total wall × N for ops visibility.
- **Composes with model-swap retry (ADR-0066)**: seeds may mix providers via `modelCandidates`.
- **Composes with apply_patch (ADR-0027)**: each candidate produces a V4A patch; selector picks the patch + applies in the parent workspace.
- **Composes with verify-guard (ADR-0076)**: when verify-guard fires N consecutive same-turn retry failures, it MAY auto-trigger `branch_search` via a future seam (left for a follow-up — this ADR ships the primitive, the auto-trigger is opt-in policy).

## Negative invariants

- `runBranchSearch` MUST NOT execute any candidate against the parent workspace — every dispatch is via `isolator.acquire(i)`.
- `Verifier` impls MUST NOT mutate the candidate's workspace (read-only diagnostics + temp file outputs only).
- A timeout/abort on ONE candidate MUST NOT cancel others — `Promise.allSettled` semantics.
- The `branch_search` tool MUST refuse cleanly (ok:false with config-pointer) when `AgentConfig.branchSearch` is absent — never falls back to a default config.
- Tier-0 smoke MUST replay the winner ONLY; losers stay in the sidecar.
