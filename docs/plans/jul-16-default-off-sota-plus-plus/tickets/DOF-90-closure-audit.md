# DOF-90 - closure audit

**Priority:** P0  
**Depends on:** every non-hold leaf

Recompute the ledger from current runtime and catalog sources. Closure requires:

- eligible coverage >= 90% in `default_on`, `resource_on`, or `policy_gated_live`
- zero ambiguous/unknown/unowned rows
- zero generated catalog drift
- every default flip has ON, OFF, inheritance, telemetry, and rollback receipts
- every deletion has a concrete supersession receipt
- every hold has an external prerequisite and recheck command

Run catalog rails, ledger hellgate, runtime default parity, focused leaf tests, typecheck, lint, and the repo's admitted integration front door. Report broad pre-existing failures separately; do not convert focused green into whole-repo closure.
