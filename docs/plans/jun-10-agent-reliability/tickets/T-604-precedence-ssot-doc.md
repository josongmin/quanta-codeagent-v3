# T-604: Precedence SSOT docs page (test-cited)

**RFC:** [06·W4](../06-rfc-rule-provenance-and-determinism.md) · **Priority:** P2 · **Size:** S · **Deps:** none · **Posture:** docs

## Deliverable
One `docs/` page consolidating the audit-verified precedence rules, each line citing its pinning test: repo-rules deeper-wins + same-dir candidate order (`src/agent/repo-rules.ts:80,148-167`), vendor priority (`src/rules/vendor-detector/normalizer.ts`), glob-rule stable sort (`src/agent/glob-rules.ts:179,405-412`), 4-section preset order, dynamic-block assembly order + rationale (`src/agent/prompt.ts:517-569`), trust-gating semantics (`src/config/merge.ts:85-149`). Include the Claude Code settings-hierarchy comparison (user<project<local<flag<policy). Purpose: stop the re-derivation tax (two audit rounds independently re-derived all of this).

## Acceptance criteria
- [ ] Every precedence claim cites a pinning test or code anchor.
- [ ] Linked from 00-index and the rules module README/comments.
