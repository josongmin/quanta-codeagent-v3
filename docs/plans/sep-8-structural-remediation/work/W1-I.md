# W1-I receipt

Status: **integrated on local `main` `29d7e4ff1`**. W1 findings are `implemented`. Not W7 `verified` 39/39.

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

- W1 owner rails + apply-patch fast-apply hellgate (Convert/Incomplete)
- pricing-ssot, persist, eval token-cost, parser, F5 journal, structured, god-code, security/patch slice boundary

## Follow-up on main (after worker receipts)

F-07.4 live `makeBashTool().classifySource` → `dispatchTool` preview is now the consumer rail (`tests/integration/sep8-remediation/r01/f07-classify-redact-path.test.ts`). Source-scan of `bash/index.ts` is no longer the completion evidence.

Same owner later closed remaining dump-shape fail-open: utility prefixes (`eval`/`command`/`timeout`/…), `ruby -e "p ENV"`, `$()` / backtick substitution, `perl -e` / `php -r` / `deno eval`. Rails: `f07-command-shape-bypass.test.ts`, ratchet.

H-PATCH-02.4: Incomplete throw reaches dispatch preview (`tests/integration/sep8-remediation/r04/h-patch-02-tool-result.test.ts`).

G-F15: production `costUsd: null` is unpriced/`unavailable`, not measured `$0`.

## Remaining

- W0.3–W0.4 (W3 R02), W0.6 R10 half, W3+ packages remain open.
- Global `prepush` not claimed as W1 closeout.
- JSONL disk persist of a spawned bash dump is not a W1 closeout rail; dispatch `preview`/`block.content` is the proven model-facing sink.
- Nested `$()` uses first `)`; unlisted language REPLs stay inventory-out.
