# Tickets

Execution order (revised — see ../README.md "Reality corrections"):

0. **T0 commit-first gate** — land the dirty acceptance-tier cluster, refresh the drift list (`driver.ts` is dirty and is T1/T2's primary surface)
1. [T2 — typed dataset/config SSOT + Pro local-path bypass fix](./02-typed-bench-config-ssot.md) — real start, highest value
2. [T4 — single DatasetFamilyProfile backend port](./04-extension-profiles-and-backend-ports.md) — headline "통합" ticket
3. [T1 — driver dedup, app driver as owner](./01-single-owner-runtime-cutover.md) — delete the dead runner chain + its pinning parity tests as a unit
4. [T5 — guard + break the selection value-cycle](./05-selection-repair-owner-split.md) — extend the TDZ import-cycle guard to `runner/batch/eval`
5. [T6 — retire the runSelectionPhase grandfather](./06-structural-closeout-and-ratchet-burndown.md) — scoped; defer module grandfathers + `run-main.ts`/`box.ts`
6. [T3 — surface thinning](./03-surface-thinning-and-shared-boot.md) — entry split done; debt relocated to `run-main.ts`/`box.ts` (near-cap)

Every ticket must report:

- exact files changed
- owner-local proof rail
- surrounding unrelated red, if any
- remaining follow-up

Every ticket should also include in its report:

- baseline state before edits
- the seam that became single-owner or newly typed
- any deleted tests/helpers that were preserving debt
