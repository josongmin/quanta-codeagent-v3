# DOF-00 - machine-readable authority ledger

**Priority:** P0  
**Depends on:** none  
**Owner:** `tools/feature-catalog` audit metadata only

## Deliverable

Add a validated ledger, not another prose count. One row per eligible feature:

```yaml
feature_id: prompt-suggestion
gate_owner: QUANTA_ENABLE_PROMPT_SUGGESTION
activation: env/config
effective_default: { cli: off, web: na, bench: na, headless: na, daemon: na }
reachability: wired
proof: { on: wire, off_identity: unit, receipt: null }
risk: behavioral-cost
decision: repair-first
owner_seam: src/apps/cli/repl/prompt-suggestion-wire.ts
rollback: QUANTA_ENABLE_PROMPT_SUGGESTION=0
duplicate_of: null
```

## Work

1. Create `tools/feature-catalog/default-off-ledger.yaml` and a schema/checker under `tools/feature-catalog/`.
2. Derive CLI effective defaults from both 19 behavior seeds and 8 tool-manifest seeds; do not hand-copy 27 values.
3. Record each surface independently. `unknown` is allowed during construction but completion requires zero unknowns.
4. Store proof receipts as feature id, command, test path, revision, exit code, and proof tier. Do not import the unreceipted 85/85 count.
5. Add anti-vacuum and red-on-injection tests for missing rows, invalid surface values, duplicate ids, and a deliberately wrong runtime default.

## DoD

- every eligible row has owner, surface defaults, reachability, risk, decision, and rollback
- ledger feature ids resolve to catalog YAML and the eligible denominator is printed deterministically
- no row is deletable without `duplicate_of` or lifecycle evidence
- checker goes RED when one known runtime default is mutated

## Verification

```sh
bun test tests/unit/default-off-ledger-hellgate.test.ts
bun fc validate
```
