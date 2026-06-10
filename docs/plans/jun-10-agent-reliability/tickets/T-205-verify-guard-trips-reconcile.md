# T-205: verify-guard max-trips doc/code reconciliation + drift-pin test

**RFC:** [02·W5](../02-rfc-evidence-claim-trace.md) · **Priority:** P1 · **Size:** S · **Deps:** none · **Posture:** gate posture unchanged (OFF)

## Deliverable
Decide the intended default (1 vs 2) and align all four surfaces: `src/agent/verify-guard.ts:102` (`DEFAULT_MAX_TRIPS = 1`), knob docs `src/apps/cli/cli-knobs.ts:584-599` (says 2), `src/apps/cli/internal.ts:386` comment (says 2), `--help` text. Add a knob-registry test pinning documented default == code constant (drift-guard pattern, cf. cli-knob-readsite-domain guard class).

## Acceptance criteria
- [ ] Single value across all four surfaces.
- [ ] Drift-pin test fails if doc and constant diverge again.
