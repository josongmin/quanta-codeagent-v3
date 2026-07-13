# SNC-00 — freeze live inventory and authoritative RED rails

**Priority:** P0
**Depends on:** none
**Parallelizable:** no

## Objective

Create executable inventories and failing behavior rails before changing authority code. This ticket does not implement the fix.

## Owned surfaces

- `tests/unit/subagent-spawn-callsite-inventory-hellgate.test.ts` (new)
- `tests/unit/subagent-lineage-authority-red-hellgate.test.ts` (new)
- existing nesting tests only where assertions encode false current ownership
- `SOURCE_TRUTH_MAP.md` if live paths differ

## Required RED cases

1. absent parent lineage is rejected instead of root-defaulted
2. `NaN`, negative, fractional, and unsafe parent depth are rejected
3. forged `req.depth` cannot affect run id, metadata, hooks, or child config
4. `branch_search` under cap `0` starts zero candidate loops
5. `subagent_fork` forced injection under a leaf authority is denied at runtime
6. lineage-less persisted handle cannot auto-resume
7. conflicting policy aliases produce a typed config failure
8. live knob override cannot widen or tighten a session-pinned policy

## Inventory contract

Use the TypeScript compiler AST, not grep-only source matching. Record each production `runAgent` import/call and classify it as root, descendant, kernel owner, or test seam. The fixture must fail on an unclassified new call site.

## Landing protocol

SNC-00 must not leave the branch red. Demonstrate each target case by temporarily activating it, capture the failing output in `reports/SNC-00.md`, then land the target rows as named `test.todo` cases tagged with the ticket that will activate them. The AST inventory itself must land green. A downstream ticket is not done until its assigned `todo` rows are active and green.

## Acceptance

```sh
bun test tests/unit/subagent-spawn-callsite-inventory-hellgate.test.ts
bun test tests/unit/subagent-lineage-authority-red-hellgate.test.ts
```

- inventory test is green and pins the complete current call-site set
- authority behavior cases have captured RED evidence and land as explicitly assigned `test.todo` rows
- no production source is changed

## Stop rule

If a failing case requires a broad e2e harness, first extract the cheapest owner-local port seam. Do not begin implementation in this ticket.
