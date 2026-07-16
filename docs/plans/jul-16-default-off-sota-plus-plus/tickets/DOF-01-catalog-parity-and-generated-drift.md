# DOF-01 - catalog parity and generated drift

**Priority:** P0  
**Depends on:** DOF-00  
**Owner:** `tools/feature-catalog/features/**`, `docs/10.feature-catalog.md`

Correct stale YAML using ledger evidence. First known rows: prompt-suggestion hold text, tool-profile CLI notes, plan-queue deferred-wire notes, objective-goal extra gate, stale-read-guard default, fsjail inverse gate, 0315 web bind default, and effective CLI tool seeds.

Each change must name the live source owner. Add runtime-reflection parity where possible; free-form labels and prose are not validation. Regenerate the markdown once after all YAML edits.

## DoD

```sh
bun fc validate
bun fc check-evidence
bun fc build
bun fc diff
```

All four exit 0. No hand edit to `docs/10.feature-catalog.md`. Any unrelated generated drift is isolated in the same catalog-sync commit and called out.
