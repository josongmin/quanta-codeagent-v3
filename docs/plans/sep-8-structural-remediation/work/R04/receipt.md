# R04 receipt

Status: **implemented** (not verified)

Package: `@/patch` (`src/patch/`)
Findings: H-PATCH-01 (P1), H-PATCH-02 (P2)
HEAD: `f5f4875799141068af73e604129c8b9a09f76007`
Worker: W1-B / R04
Worktree: `/Users/songmin/quanta-codeagent-v3-w1-r04`

## Findings

- **H-PATCH-01:** git unified rename (`rename from`/`rename to` plus `---/+++`) was discarded and emitted as `Update File: old.py`. Converter now keeps file-section rename IR, emits `Update File` + `Move to`, and `parsePatch` yields `kind:"update"` with `moveTo`. Inconsistent/incomplete rename metadata throws `PatchConvertError` (no degrade to in-place update). Public `PatchOp` has no `kind:"move"`.
- **H-PATCH-02:** `rollback()` swallowed undo errors and commit catch always said `was rolled back`; empty-path `messageForModel` said `the file is unchanged`. Undo failures are collected as `PatchRollbackIncompleteError` (`outcome:"rollbackIncomplete"`, `failedUndos`, `uncertainPaths`). Clean undo still uses empty-path `PatchApplyError` (`was rolled back`) so unchanged is allowed only then.

## Files changed

Source:

- `src/patch/types.ts` — `PatchConvertError`, `PatchRollbackIncompleteError`, `UndoFailure`
- `src/patch/git-path.ts` (new) — git quoted-path decode + a/b strip
- `src/patch/unified-to-v4a.ts` — rename IR scan, Move to emit, reject inconsistent rename
- `src/patch/parser.ts` — rename-only `Update`+`Move to` with zero hunks allowed
- `src/patch/commit-journal.ts` (new) — inverse journal + rollback collect + rethrow
- `src/patch/applier.ts` — journal entries carry paths; no swallow
- `src/patch/message-for-model.ts` — Incomplete / convert hints; unchanged only on clean rollback

Tests:

- `tests/unit/patch/unified-to-v4a-scenarios.test.ts` — S-OP-5 reversed
- `tests/unit/sep8-remediation/r04/h-patch-01-unified-rename.test.ts`
- `tests/unit/sep8-remediation/r04/h-patch-02-rollback-truth.test.ts`
- `tests/integration/sep8-remediation/r04/h-patch-01-apply-rename.test.ts`

Artifacts:

- `docs/plans/sep-8-structural-remediation/work/R04/receipt.md`
- `docs/plans/sep-8-structural-remediation/work/R04/integration-delta.md`

Not edited: `src/patch/index.ts`, `src/tool/apply-patch.ts`, README/ACTIONS/WAVES/waves.json/verify-waves.mjs/W0.md.

## Removed path

- Discard of `rename from`/`rename to` as inert git meta (fallback to update of old path)
- Empty `catch {}` swallow in rollback
- Unconditional `Patch commit failed and was rolled back` when any undo failed
- `the file is unchanged` on incomplete rollback

## Commands

```sh
bun docs/plans/sep-8-structural-remediation/verify-waves.mjs --group R04 <each written path>
# → status PASS

bun test \
  tests/unit/sep8-remediation/r04/ \
  tests/integration/sep8-remediation/r04/ \
  tests/unit/patch/unified-to-v4a-scenarios.test.ts \
  tests/unit/patch/applier-rollback-rename-delete.test.ts \
  tests/unit/patch/parser.test.ts \
  tests/unit/patch/applier-journal.f5.test.ts \
  tests/unit/patch-structured-apply-hellgate.test.ts \
  tests/unit/patch/unified-to-v4a-hellgate.test.ts
# → 122 pass, 0 fail

bunx @biomejs/biome check src/patch/{types,git-path,unified-to-v4a,commit-journal,applier,parser,message-for-model}.ts
# → clean
```

`applier.ts` is 764 lines (was 761). Rollback extracted to `commit-journal.ts`. Not in the 900–999 cohort. No allowlist change.

## RED → GREEN → mutation

RED (current HEAD converter/applier): 11 failing tests — S-OP-5 still `moveTo` undefined; rename apply left `old.py`; incomplete rollback was `PatchApplyError` claiming rolled back.

GREEN: those tests pass. Successful-rollback control still restores original bytes and may say unchanged. F5 mutate-then-throw still recovers when undo succeeds. Destination collision still rejected. Parser still rejects empty Update without `Move to`.

Mutation that must stay RED:

- Restore rename-header discard / always `Update File: fromPath` → S-OP-5 and r04 rename tests fail (`moveTo` missing, old path remains).
- Restore empty `catch {}` swallow or always wrap as `was rolled back` → r04 rollbackIncomplete tests fail (leftover `A-edited` vs claimed restore).
- Restore `the file is unchanged` for Incomplete → `messageForModel` assertion fails.

## Remaining gap

- Barrel re-exports of `PatchConvertError` / `PatchRollbackIncompleteError` / `UndoFailure` — UNAPPLIED (see `integration-delta.md`).
- `src/tool/apply-patch.ts` typed error/result projection (convert throw before parse; Incomplete vs clean rollback; fast-apply `classifyFastApplyError`) — UNAPPLIED.
- No new multi-file crash-atomicity guarantee. Incomplete names uncertain paths only.
- Symlink escape remains the jail port’s job; converter emits literal path strings.

## integration-delta

See `docs/plans/sep-8-structural-remediation/work/R04/integration-delta.md`.
