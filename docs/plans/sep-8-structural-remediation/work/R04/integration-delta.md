# R04 integration-delta — APPLIED (W1-I, `29d7e4ff1`)

Status: **applied** on integrated source. Worker originally left this UNAPPLIED; W1-I applied barrel + fallback-wire. Content below is the applied mapping.

## Barrel re-exports needed (`src/patch/index.ts`)

New public types live in `src/patch/types.ts`. Tests import them from
`@/patch/types`. Integrator should add:

```ts
export type { UndoFailure } from "./types"
export {
  PatchAnchorNotFoundError,
  PatchApplyError,
  PatchConvertError,
  PatchParseError,
  PatchRollbackIncompleteError,
} from "./types"
```

`PatchOp` is unchanged: `{ kind: "update", path, moveTo?, hunks }`. Do not add
`kind: "move"`.

## `src/tool/apply-patch.ts` projection

### H-PATCH-01 — `PatchConvertError`

`guardedParseAndApply` currently:

```ts
const normalizedPatch = isUnifiedDiff(patchText) ? unifiedDiffToV4A(patchText) : patchText
const patch = parsePatch(normalizedPatch)
```

`unifiedDiffToV4A` now **throws** `PatchConvertError` on inconsistent/incomplete
rename metadata (it no longer degrades to an in-place update of the old path).
That throw happens **before** `parsePatch`.

Recommended mapping:

- Catch/propagate `PatchConvertError` as a parse-class failure (same family as
  `PatchParseError`): the model must correct rename headers, not retry an
  in-place edit of the old path.
- `classifyFastApplyError` (`apply-patch-fallback-wire.ts`): add
  `err instanceof PatchConvertError → "parse_error"` (or a new closed kind
  `convert_error` if the seam is extended). Today it returns `null` for this
  class because it is not re-exported from the barrel and is not
  `PatchParseError`.
- `failingTargetPath`: convert errors have no single op path; prefer
  `undefined` (omit snapshot), same as parse errors.

Symlink / jail policy is unchanged: converter emits **literal** path strings
(`sub/../dest` is not rewritten). `FsJailFileSystemPort.assertInside` /
`resolveJailed` still owns symlink-escape rejection.

### H-PATCH-02 — `PatchRollbackIncompleteError`

`applyPatch` now distinguishes:

| Outcome | Thrown class | Model claim |
|---|---|---|
| all required undos succeeded | `PatchApplyError` empty path, message contains `was rolled back` | `messageForModel` may say `the file is unchanged` |
| any undo failed | `PatchRollbackIncompleteError` (`outcome: "rollbackIncomplete"`) | MUST NOT say `the file is unchanged` |

`messageForModel` already maps Incomplete in-slice. Tool wrapper still needs:

1. **Do not** collapse Incomplete into the empty-path `PatchApplyError` wrap.
   `classifyFastApplyError` today returns `null` for Incomplete (not a
   `PatchApplyError`). That is safer than classifying it as a recoverable
   `apply_error` that implies a clean restore. Prefer a **non-recoverable**
   (or new) kind so fast-apply fallback does not retry under a false clean-disk
   assumption. If it must stay `apply_error`, the tool **output text** must still
   surface `failedUndos` / `uncertainPaths` and must not say rolled back / unchanged.
2. `failingTargetPath`: Incomplete has empty/absent single path. Use
   `uncertainPaths[0]` only as a hint; prefer listing all `uncertainPaths` in the
   tool output. Do not claim the rest of the patch was restored.
3. Structured apply (`applyPatchStructured` → `apply-patch-structured-tool.ts`)
   already calls `messageForModel(error)`, so per-op Incomplete hints will be
   honest once the class is thrown. No extra mapping required there beyond
   barrel export so `instanceof` checks in the tool layer work after a
   cross-slice import from `@/patch`.

## What this worker did NOT claim

- Multi-file crash atomicity. Incomplete means leftover bytes may remain; the
  typed error names the uncertain paths. Successful rollback is still the
  historical all-or-nothing path when every undo succeeds.
