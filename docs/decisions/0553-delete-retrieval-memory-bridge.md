# ADR-0553 — Delete the memory ↔ retrieval bridge, the `AgentConfig.retrievalStack` slot and the `QUANTA_RETRIEVAL_HYBRID` gate (the decision is DELETE, not wire)

Status: Accepted (2026-08-25)
Slice: `src/runner/assemble/` · `src/host/runtime/` · `src/agent/types/wire-slots-session.ts` · `src/sdk/runtime/base.ts` · `src/config/knob-inventory/host.ts`
Feature: `retrieval-composition-wire` (feature-catalog §5-memory) — retired
Related: ADR-0159 (the retrieval stack + its "composition-root wire" follow-up), ADR-0278 (which mis-described the slot as read), ADR-0550 (the wire-or-delete precedent that resolved to WIRE — this one resolves the other way), jul-3 strategy-audit plan D2 (which deleted the localize half)
Ratchet: `tests/unit/retrieval-bridge-deleted-ratchet.test.ts`

## Context

ADR-0159 landed `@/retrieval` (reranker registry, RRF, BM25-secondary, tier-aware, embedding port, commit embedder) and then, in its "composition-root wire" follow-up, three pieces of plumbing meant to put it on the recall path:

1. `rankWithRetrievalStack(candidates, query, now, stack)` in `src/runner/assemble/retrieval-memory-bridge.ts` — run memory's `rankEntries`, then hand the ranked list to `stack.defaultReranker`.
2. `AgentConfig.retrievalStack` — a slot for the built stack, mirrored into `SessionDeps`, `BaseSlotContext`, the SDK's `RuntimeAgentConfigAugments`, and the base-slot fold.
3. `QUANTA_RETRIEVAL_HYBRID="1"` — a host-root env gate (`buildRetrievalStackFromEnv` in `agent-arg-builder.ts`) that built the stack and wrote it into the slot, plus a knob-inventory entry and a byte-identity hellgate case.

A sibling localize bridge (`runLocalizeHybrid`) was deleted under the jul-3 plan (D2). The memory half survived, and the catalog kept describing both.

What an audit of the surviving half found, all verified against the tree rather than the docs:

- **The slot was written and never read.** `agent-arg-builder.ts:686` wrote `retrievalStack: buildRetrievalStackFromEnv(env)`; no code path — not memory recall, not a tool, not the loop — ever read `config.retrievalStack`. `rankWithRetrievalStack` had zero non-test callers. ADR-0278 §Context states the slot "is read by memory recall and the localize tool"; that was never true.
- **Even if wired, it could not change a result.** `rankEntries` (`src/memory/ranking.ts:272`) clips the candidate list to `query.limit` *before* returning, so the bridge's stage-2 reranker only ever saw the already-final top-N and could at most permute it. Measured on the recall fixture: relevant-in-top-5 went 1 → 1.
- **The stock stack's default reranker is `identity`** (`src/runner/assemble/retrieval.ts`, `DEFAULT_RETRIEVAL_RERANKER`). The gate an operator could actually flip built a stack whose reranker returns its input unchanged. Setting `QUANTA_RETRIEVAL_HYBRID=1` was a no-op twice over.

So the wire-or-delete question here has a different answer from ADR-0550. There the plumbing was complete and one call was missing. Here the plumbing existed, but the design under it could not deliver the effect it promised: rerank-after-clip is structurally inert, and the default strategy is inert by construction. Wiring the missing read would have produced a slot that is read and still changes nothing.

## Decision

**DELETE.**

Removed in one pass:

- `src/runner/assemble/retrieval-memory-bridge.ts` and its barrel export.
- `AgentConfig.retrievalStack` (`wire-slots-session.ts`), `SessionDeps.retrievalStack` + its spread (`runner/assemble/config.ts`), `BaseSlotContext.retrievalStack` + resolver #2 (`base-slot-registry.ts`), `RuntimeAgentConfigAugments.retrievalStack` (`sdk/runtime/base.ts`).
- `buildRetrievalStackFromEnv`, `isRetrievalHybridEnabled` and the host copy of `assembleMemoryAuto` (`agent-arg-builder.ts`) with the `@/host/runtime` and `@/apps/agent` re-exports of the latter. The host copy hard-coded `0.7` / `1` instead of `DEFAULT_TRIGGER_POLICY` and had zero call sites; the canonical resolver is `src/memory/auto-trigger/wire.ts#assembleMemoryAuto`. (A third copy lives in `memory-factory.ts` and is another lane's.)
- The `QUANTA_RETRIEVAL_HYBRID` knob-inventory entry and the two references in the byte-identity hellgate (`DRIVEN` strip list + the `retrieval hybrid` matrix case; its two snapshot entries are pruned).
- `tests/unit/retrieval-composition-wire-hellgate.test.ts`, `tests/integration/retrieval-composition-root.test.ts` — they proved the bridge's identity behaviour and the slot's default-OFF shape, both of which no longer exist.

Kept: `buildRetrievalStackCore` and the rest of `src/runner/assemble/retrieval.ts`. It is the surface-agnostic assembler for `@/retrieval` and is consumer-less today; it is the right shape for a future consumer and deleting it buys nothing.

Not touched: `tools/feature-catalog/default-off-ledger.yaml` (the gate was never in it, so the plan-metrics ratchet does not move) and `docs/plans/*` numbers.

The gate was default-OFF, so the runtime default is byte-identical: every base built with the knob unset had no `retrievalStack` key before and has none now. The only observable change is that `QUANTA_RETRIEVAL_HYBRID=1` no longer allocates a registry it then never consults.

## Consequences

- **Ratchet.** `tests/unit/retrieval-bridge-deleted-ratchet.test.ts` is a closed-universe guard over `src/**`: no file may contain `rankWithRetrievalStack`, `runLocalizeHybrid`, `retrieval-localize-bridge`, `retrieval-memory-bridge`, `buildRetrievalStackFromEnv` or the `QUANTA_RETRIEVAL_HYBRID` literal, nor declare a `retrievalStack` key; and a type-level `never` sentinel fails `typecheck:tests` if `AgentConfig` regrows the slot. Doc-comment mentions count — see the next point for why.
- **The jul-3 D2 doc-scrub debt is paid.** D2 deleted `runLocalizeHybrid` but left it described in the catalog YAML and the rendered catalog for weeks. That is how a dead seam gets re-wired by the next reader. The catalog entry is now a `status: deprecated` / `lifecycle_stage: removed` tombstone pointing at this ADR; ADR-0278 §Context is corrected; ADR-0159 carries a dated superseded note rather than a rewrite.
- **What a real BM25-over-memory must do differently.** Three requirements, each the negation of a defect found here:
  1. Rerank *before* the clip. The reranker must see the full post-filter candidate set (or a wider top-K than the final N), which means the rerank seam sits inside memory ranking's pipeline ahead of `query.limit`, not after `rankEntries` returns.
  2. Promote a non-identity default. A gate that builds a stack whose default reranker is `identity` is a gate that lies; the default must be a strategy with a measured effect (`score-fusion-rrf` or `bm25-secondary`), and the promotion must be asserted by a test that shows a ranking change on a fixture.
  3. Respect the `@/memory` fence. `@/memory` may only reach `@/storage` + `@/shared` (RFC §3.1); it may not import `@/retrieval`. The seam therefore has to be a port that `@/memory` *declares* and `@/runner` *fulfils* — the inverse of this bridge, which lived in `@/runner` and called memory's public ranking after the fact.
- **Remaining consumer-less code.** `buildRetrievalStackCore` (and through it the whole `@/retrieval` registry) has no in-tree caller. That is recorded here rather than hidden; it is the one thing a future consumer would reuse.
