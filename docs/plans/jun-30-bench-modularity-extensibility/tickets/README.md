# Tickets

Execution order:

1. [T1 — single-owner runtime cutover](./01-single-owner-runtime-cutover.md)
2. [T2 — typed bench config SSOT](./02-typed-bench-config-ssot.md)
3. [T3 — surface thinning + shared boot](./03-surface-thinning-and-shared-boot.md)
4. [T4 — extension profiles + backend ports](./04-extension-profiles-and-backend-ports.md)
5. [T5 — selection/repair owner split](./05-selection-repair-owner-split.md)
6. [T6 — structural closeout + ratchet burndown](./06-structural-closeout-and-ratchet-burndown.md)

Every ticket must report:

- exact files changed
- owner-local proof rail
- surrounding unrelated red, if any
- remaining follow-up

Every ticket should also include in its report:

- baseline state before edits
- the seam that became single-owner or newly typed
- any deleted tests/helpers that were preserving debt
