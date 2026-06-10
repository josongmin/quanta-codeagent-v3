# T-301: affected_tests tool (convention + import-graph + co-change, attributed)

**RFC:** [03·W1](../03-rfc-post-edit-regression-guards.md) · **Priority:** P1 · **Size:** L · **Deps:** none · **Posture:** OFF (`QUANTA_AFFECTED_TESTS`)

## Deliverable
Read-only tool mapping changed file(s) → candidate tests via three deterministic, per-item-attributed sources:
1. **Convention:** `foo.ts` → `foo.test.ts`, `__tests__/foo*`, `tests/**/foo*`.
2. **Import graph:** reverse-dep walk over the TS import graph to test files (house position: import graph is the validated technique; grep-reachability diverges). Bounded walk, explicit logged cap, per-turn cache.
3. **Co-change:** delegate to existing `git_co_change` (`src/tool/git/co-change.ts`), filtered to test paths.
Output: ranked list, each entry `{source: convention|import-graph|co-change}`. No silent cutoffs. Registered via manifest SSOT (`src/tool/surface/manifest.ts`) + knob registry + feature-catalog DoD (zero-unwired ratchet).

## Acceptance criteria
- [ ] Unit per source on a fixture tree.
- [ ] Hellgate: two-hop transitive importer's test surfaces with `import-graph` provenance.
- [ ] Cap logged when truncating (no-silent-caps rule).
- [ ] SOTA note in PR: no competitor ships affected-test selection (exceed-class).
