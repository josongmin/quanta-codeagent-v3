# ADR-0433 — Adversarial multi-voter verification layer

- Status: Accepted
- Date: 2026-06-02
- Slice: `src/agent/multi-voter/` (additive to `src/agent/branch-search/`, ADR-0084)

## Context

Today the speculative branch search (ADR-0084,
`src/agent/branch-search/{verify,score}.ts`) is a deterministic N-best over
candidate branches. Its LLM signal is a SINGLE `llm_judge` weight — one model,
one verdict, folded into a per-candidate score. There is:

- NO N-voter-per-candidate adversarial aggregation, and
- NO per-surface verifier skills.

Claude's `init-verifiers` adopts a `VOTES_PER_BUG` fan-out (N independent
voters per claim) plus per-surface verifier skills (cli / api / playwright).
That pattern raises precision on "did this fix actually work" by making
verification adversarial and quorum-gated rather than single-shot.

## Decision

Add an **adversarial multi-voter verification layer** as a NEW, orthogonal,
default-OFF slice. It does NOT modify the existing branch-search control flow.

1. **Multi-voter core** (`voter.ts`). For a claim/candidate fix, run N
   independent voters — each an `LLMPort` (a `ScriptedLLM` double in tests) —
   in PARALLEL. Each voter is prompted to **REFUTE** the claim and to
   **default to FAIL under uncertainty**, and emits a typed
   `Verdict { pass; confidence; reason }`. Aggregate by quorum into
   `VoteOutcome { verdict; votes; passVotes; totalVotes; quorumMet }`.

   - **Refute bias (negative invariant):** a voter whose output is unparseable,
     or whose stream THROWS, is counted as a REFUTE (`pass:false`). The loop
     SURVIVES a flaky provider (`Promise.all` over per-voter try/catch — a
     thrown voter becomes a `source:"threw"` record, never a thrown aggregate).
   - **Quorum semantics:** ABSENT quorum ⇒ strict majority
     (`passVotes * 2 > totalVotes`), so a tie fails-closed. EXPLICIT quorum `q`
     ⇒ `passVotes / totalVotes >= q`. Presence, not value, selects the rule, so
     an explicit `0.5` is honoured distinctly from the default. Zero voters
     fails-closed.
   - Optional `lens` per voter (diverse-lens, Agentless §4.2) folded into the
     refute prompt.

2. **Branch-search composition** (`signal.ts`). `voterQuorumSignal(outcome)`
   turns a `VoteOutcome` into ONE additive `VerifierSignal` of the new kind
   `llm_voter_quorum` — `pass` mirrors the verdict, `magnitude` is the graded
   pass-fraction. A new `VerifierKind` member and a `DEFAULT_WEIGHTS` entry
   (`0.3`) are added.

   - **Default-OFF / byte-identical (negative invariant):** the scorer reads
     the `llm_voter_quorum` weight ONLY when a signal of that kind is present
     in a candidate's signal list. Such a signal is produced ONLY when a caller
     explicitly composes a multi-voter run in. Absent that wiring, NO
     `llm_voter_quorum` signal exists, `scoreWith` never reads the new weight,
     and the branch-search score is byte-identical to pre-ADR-0433. This is
     proven by a hellgate test that hand-computes the expected total from the
     non-voter weight mass.

3. **Per-surface verifier skill spec** (`skill-spec.ts`). A typed
   `VerifierSkillSpec` (`surface: cli | api | playwright`, `intent`,
   `votesPerBug`, optional `target` + `lenses`) + a pure generator stub
   `generateVerifierSkill` that renders a SKILL.md-shaped artefact. Full
   skill-file emission/persistence is deliberately left as a wiring step.

## Consequences

- The branch-search scorer can now reward "9 of 10 adversarial voters passed"
  above "6 of 10", orthogonally to tsc/test/lint/llm_judge.
- Adding `llm_voter_quorum` to the closed `VerifierKind` union keeps the scorer
  exhaustiveness check honest (adding a kind is still a compile-time decision).
- No control-flow change to `propose`/`search`/`select`; the slice is leaf and
  imports DOWN to `@/llm` + `@/shared` + the branch-search barrel only.

## Wiring status (for the integrator)

- Core + signal + spec + barrel landed and tested (default-OFF).
- NOT yet wired into `search.ts`/`tool.ts`: a production caller must build the
  `Voter[]` from `AgentConfig.modelCandidates`, run `runMultiVoter`, and
  concatenate `voterQuorumSignal(outcome)` onto a candidate's verifier signals.
  That is a follow-up wiring step (kept out of scope to preserve byte-identical
  default).
