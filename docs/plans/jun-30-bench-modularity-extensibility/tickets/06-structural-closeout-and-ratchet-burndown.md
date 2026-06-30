# T6 — structural closeout and ratchet burndown

**Priority:** P1  
**Depends on:** T1-T5  
**Parallelizable:** no

## Problem

Both structural ratchets (`god-code-ratchet`, `src-no-sketchy-code`) are **already GREEN at HEAD** — but green via grandfathering, not via closure. The packet is not structurally closed until the bench-owned grandfathered entries are burned down or explicitly justified, and unrelated repo-global grandfathers stay separated.

Current relevant facts (re-verify against `tools/god-code/allowlist.json` and the src-no-sketchy allowlist before editing — these drift):

- bench-owned grandfathered god-MODULES: `src/apps/bench/cli.ts`, `src/apps/bench/eval/driver.ts`, `src/apps/bench/index.ts`, `src/runner/batch/eval/driver.ts`
- bench-owned grandfathered god-FUNCTION: `src/runner/batch/eval/driver.ts::runSelectionPhase`
- the previously-cited `runRepairPhase` / `buildConfig` functions are no longer fresh failures — recent convergence commits shrank them below threshold; do not re-list them as red
- bench `src-no-sketchy-code` entries are allowlisted composition-root env reads with rationale; treat those as the legitimate boundary unless T2 makes a specific read removable
- unrelated repo-global grandfathers (`src/tool/**`, `src/host/**`, etc.) are out of scope and must not be folded into bench closeout

## Goal

Close bench-owned structural debt and make the remaining unrelated red explicit.

## Scope

- bench-owned `god-code` and `src-no-sketchy-code` failures
- any bench-specific string-parity tests that preserve debt rather than prove behavior
- bench closeout reporting

## Entry conditions

- `T1` through `T5` must be closed or explicitly partial with documented residue
- baseline failing sets for `god-code-ratchet` and `src-no-sketchy-code` must be captured in the report before edits

## Exact edit surfaces

Likely touched:

- bench-owned files still in the fresh failure set
- bench-owned tests that preserve duplication debt
- closeout report(s)

## Required changes

1. Remove bench-owned grandfathered allowlist entries that T1–T5 made splittable (`runSelectionPhase` function once `selection` is decomposed; shrink the four grandfathered bench modules where the earlier tickets already moved logic out).
2. After each removal, prove `god-code-ratchet` stays GREEN with fewer grandfathers — the ratchet's stale-entry guard fails if you remove an entry whose file still violates, so this is real proof, not prose.
3. Leave bench `src-no-sketchy-code` allowlist entries in place if they remain legitimate composition-root reads; only remove ones T2 actually eliminated, and update their rationale otherwise.
4. Replace any debt-preserving architecture tests with behavior/contract tests where needed.
5. Report remaining unrelated repo-global grandfathers separately instead of folding them into bench closeout.

## Suggested implementation order

1. capture exact failing sets before edits
2. remove bench-owned fresh failures
3. rerun rails and split remaining failures into bench-owned vs unrelated
4. update reports with the final split

## Explicit non-goals

- claiming repo-global structural green if unrelated owners remain red
- refactoring unrelated `src/tool/**`, `src/host/**`, `src/lsp/**`, or `src/agent/**` files only to make the bench packet look cleaner

## Definition of done

- bench-owned grandfathered `god-code` entries are fewer than at packet start, and every remaining one is justified in the report
- bench `src-no-sketchy-code` allowlist reflects reality (no stale entries; remaining ones still have valid composition-root rationale)
- both ratchets are still GREEN, now with fewer bench grandfathers
- closeout explicitly distinguishes:
  - bench-owned grandfathers burned down
  - bench-owned grandfathers kept (with justification)
  - unrelated repo-global grandfathers (out of scope)
  - any live-only unverified surface

## Deliverables

- report with exact before/after failure sets
- final bench-owned status statement
- explicit unrelated-owner residue list if any remains

## Proof rails

```sh
bun run typecheck
bun test tests/unit/god-code-ratchet.test.ts
bun test tests/unit/src-no-sketchy-code.test.ts
bun test tests/unit/surface-coupling-ratchet.test.ts
bun test tests/unit/terminal-defaults-ratchet.test.ts
```

Record the exact before/after failure set in a report under `reports/`.

## Stop rule

If this ticket becomes a repo-wide cleanup campaign, stop and split the unrelated owners into separate work.

## Blocked if

- bench-owned fresh failure set is still moving because earlier tickets are not actually closed
- a remaining failure is shared with an unrelated owner and cannot be safely separated
