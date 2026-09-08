# W1-I receipt

Status: **integrated**. W1 findings are `implemented` on merged source. Not W7 `verified` 39/39.

## Merge order

R01 → R04 → R09, then reserved/I wiring.

Worker reserved violation: R09 wrote `src/apps/eval/report/index.ts` (basename reserved). Copied owner files without that path, then applied the barrel export as I.

## I applied

- `src/patch/index.ts` — `PatchConvertError`, `PatchRollbackIncompleteError`, `UndoFailure`
- `src/tool/apply-patch.ts` — convert throw documented; errors propagate
- `src/tool/apply-patch-fallback-wire.ts` — Convert → `parse_error`; Incomplete → not recoverable
- `src/observability/usage-accounting/index.ts` — provenance helpers
- `src/apps/eval/report/index.ts` — `projectEvalCost` / `EvalCostPricing`

## Tests on merged source

- 169 pass: W1 owner rails + apply-patch fast-apply hellgate (Convert/Incomplete)
- 100 pass: pricing-ssot, persist, eval token-cost, parser, F5 journal, structured, god-code, security/patch slice boundary

## Remaining gap

- F-07.4 live `makeBashTool().classifySource` was scanned, not imported in worker worktree; producer call pattern is pinned.
- W0.3–W0.5, W0.6 R10 half, W0.8 for later packages remain open.
- Global `prepush` not claimed as W1 closeout.
- Worktrees `sep8-w1-r01` / `r04` / `r09` still exist; not deleted.
