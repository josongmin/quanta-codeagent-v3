# T-201: Prose path-claim audit (extractor + builder + finish-seam annotation)

**RFC:** [02·W1](../02-rfc-evidence-claim-trace.md) · **Priority:** P1 · **Size:** L · **Deps:** none (coordinate outcome shape with T-701) · **Posture:** ON (annotate-only)

## Deliverable
1. **Prose path extractor (new — no existing utility; mention-runner parses `@`-mentions only):** deterministic, anchored extraction of repo-relative + absolute path references from final assistant text, incl. fenced/inline code spans. FP-zero adversarial fixture suite: URLs, version strings, `a/b` diff prefixes, prose slashes.
2. **Audit builder:** per path → `{path, exists (stat-only), observedInTrace (read/edit/grep-hit this session)}`.
3. **Wiring:** attach as `claimAudit` annotation at `finishAgentSession` (`src/agent/loop/session-lifecycle.ts:123`) — NOT turn-outcome, NOT the guard chain (annotate-only path).

## Evidence anchors
SOTA: no competitor validates citations at runtime (Cursor/CC are prompt-format-only) — exceed-class. `AgentOutcome` `src/agent/types/agent-outcome.ts:77-128`.

## Acceptance criteria
- [ ] Nonexistent claimed path → flagged; session-read path → clean; pathless prose → zero-cost no-op.
- [ ] Extractor adversarial fixtures green (FP-zero bar).
- [ ] Cost bound: stat per unique mentioned path, no file reads.
- [ ] Outcome field additive; hosts ignoring it unaffected.
