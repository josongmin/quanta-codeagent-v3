# T-601: Vendor-collision surfacing

**RFC:** [06·W1](../06-rfc-rule-provenance-and-determinism.md) · **Priority:** P2 · **Size:** S · **Deps:** none · **Posture:** ON (observability only; selection unchanged)

## Deliverable
Additive `collisions: ReadonlyArray<{sourcePath, winnerVendor, loserVendor}>` on `DetectionResult`, populated by `resolveCollisions` (`src/rules/vendor-detector/normalizer.ts:109-139` — silent drop today; ADR-0205 specified a warning that was never built). Consumers: composition-time debug/log line + `/state`-class panel listing active rules and dropped collisions. Amend ADR-0205 noting closure.

## Acceptance criteria
- [ ] Same sourcePath, two vendors → collision recorded; winner per priority table unchanged.
- [ ] Zero collisions → empty array; rule rendering byte-identical.
- [ ] Panel/log consumer test.
