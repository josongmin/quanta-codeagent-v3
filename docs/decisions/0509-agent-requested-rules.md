# ADR-0509: agent-requested rules (description-only, fetch-on-demand)

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - `src/agent/agent-requested-rules.ts` (`RequestableRule`, `matchRulesByDescription`)
  - Tests: `tests/unit/agent-requested-rules-hellgate.test.ts`
  - Absorbs: Cursor agent-requested rules (gap-other-agent GAP 6)

## Context

Cursor rules can be "agent-requested": a description-only rule (no globs, not always-apply) that the
model pulls in on demand by matching its task against the rule's description. quanta's glob-rule loader
DROPPED such rules (they can never auto-inject), so they were unusable.

## Decision

A pure `matchRulesByDescription(query, rules, limit)` over `RequestableRule {name, description, body}`:
deterministic token-overlap scoring (lowercase, split non-alnum, drop short tokens + a conventional
stopword set, Set-dedup), score>0, sorted by score desc then name (stable tie-break), `limit`-capped.
NO tuned threshold (standard IR practice). This is the ESSENTIAL matcher only — maturity L2. The
loader change (collect description-only rules into a requestable index instead of dropping) + the
`fetch_rules` tool + composition-root injection are the documented integration follow-up (the matcher
has no production data source until then).

## Consequences

The selection logic is landed + fuzz-proven against a brute-force oracle; the live `fetch_rules` tool
is a clean follow-up that wires the index + tool over this matcher.
