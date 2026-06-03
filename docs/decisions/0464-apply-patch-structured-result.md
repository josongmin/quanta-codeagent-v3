# ADR-0464 — Structured per-file apply result + messageForModel (self-correcting edits)

**Status:** Accepted (2026-06-03)
**Type:** Additive domain slice (`@/patch`) — new function + types alongside the
existing throwing applier. Default-OFF by construction (opt-in entrypoint).
**Scope:** `src/patch/structured-types.ts`, `src/patch/structured.ts`,
`src/patch/message-for-model.ts`, the `index.ts` barrel re-export, and the
hellgate `tests/unit/patch-structured-apply-hellgate.test.ts`. NO shared files,
NO tool-surface wiring (see Integration TODOs).
**Default-OFF:** the canonical `applyPatch` (`./applier`) is byte-identical —
unchanged source, still throws its typed errors wholesale. Callers receive the
new per-file behaviour ONLY by calling the new `applyPatchStructured`. A
deployment that never calls the new entrypoint sees zero change.

ADR-number note: 0461/0462 were the highest existing decisions when this slice
was authored; this slice was assigned 0464 by the integration plan.

## Context

`@/patch` and `src/tool/apply-patch.ts` are **throw-only**: `parsePatch` throws
`PatchParseError`, `applyPatch` throws `PatchApplyError` /
`PatchAnchorNotFoundError`, and the tool's jail adapter throws
`FsJailViolationError`. Critically, `applyPatch` is **all-or-nothing across the
whole patch** — Phase 1 plans every op, Phase 2 commits with a reverse journal,
and a single bad hunk in op 3 rolls back ops 1 and 2 and rethrows. A multi-file
patch therefore aborts wholesale on the first bad hunk.

Cursor's `ApplyAgentDiff` takes the opposite stance: it RETURNS a structured
per-file outcome so the LLM can self-correct only the file that failed.
Verbatim proto fields:

- `ApplyAgentDiffSuccess.applied_changes[]` = `{ path, change_type
  (CREATED|MODIFIED|DELETED), before_content?, after_content?, error?,
  message_for_model? }`
- `ApplyAgentDiffError` = `{ error, applied_changes[] (partial) }`

The value is concrete: when file B's hunk anchors fine but file A's context has
drifted, the model should be told "re-anchor file A" and keep file B's change,
rather than re-emitting the entire multi-file patch.

## Decision

Add a PURE, no-throw, default-OFF counterpart to `applyPatch` in `@/patch`,
**reusing the existing applier for the actual edit** so no locator / fuzzy-tier
logic is duplicated.

1. **Types** (`structured-types.ts`) — `ApplyChangeType`
   (`"created" | "modified" | "deleted"`, lower-cased to match the codebase's
   union-literal convention), `AppliedChange` (Cursor's per-file entry verbatim:
   `path`, `changeType`, optional `movedTo`/`beforeContent`/`afterContent`/
   `error`/`messageForModel`), and `StructuredApplyOutcome`
   (`{ appliedChanges, allOk }` — the Success/Error proto split unified into one
   struct with `allOk` as the discriminator).

2. **`applyPatchStructured(patch, fs): Promise<Result<StructuredApplyOutcome>>`**
   (`structured.ts`) — iterates ops in patch order; for each op it:
   - snapshots `beforeContent` via the injected port (best-effort),
   - applies that ONE op by delegating to `applyPatch({ ops: [op] }, fs)` — the
     single-op patch reuses the canonical pre-flight + locator + atomic
     plan/commit/rollback, so the op either fully lands or leaves its file
     untouched,
   - on success captures `afterContent` (read-back; none for delete; the move's
     result is read at the destination),
   - on the typed error builds a FAILURE `AppliedChange` carrying the error's
     `.message` + `messageForModel(...)` and **continues to the next op**.
   `allOk` is `true` iff every entry succeeded.

3. **`messageForModel(error): string`** (`message-for-model.ts`) — a total,
   no-throw map from each typed error to a compact, model-facing retry hint:
   `PatchAnchorNotFoundError` → "context drifted, re-read & regenerate this
   hunk"; `PatchApplyError` → path (+hunk) + detail; `PatchParseError` →
   "fix V4A syntax at line N"; jail breach → "path outside the workspace";
   fallback → generic "apply failed: <msg>". The hints contain NO patch text /
   file content / anchor lines — only the categorical failure + path + the
   applier's own short detail.

### Per-file isolation — why a separate function, not a flag on `applyPatch`

`applyPatch`'s atomicity is a load-bearing security property (a partially-applied
multi-file patch is a real hazard). We do NOT weaken it. Instead the new function
calls `applyPatch` once PER OP, so each op keeps its own all-or-nothing guarantee
(a failed op's file is rolled back by the applier and left byte-identical to its
prior on-disk content), while the OUTER loop tolerates one op failing and keeps
the others. An EARLIER op that succeeded stays applied even if a LATER op fails —
this is exactly Cursor's partial `applied_changes[]`.

### `@/patch` stays pure — no upward import for the jail error

`FsJailViolationError` lives in `@/tool` (the slice fence forbids `@/patch →
@/tool`). `messageForModel` recognises a jail breach **structurally** (an error
whose `name === "FsJailViolationError"` carrying `attemptedPath`/`jailRoot`),
so the boundary-specific hint is produced without importing upward. This mirrors
the `ToolContext` duck-typing discipline in ARCHITECTURE.md §2.

## Default-OFF / byte-identical proof

- `applier.ts`, `parser.ts`, `types.ts` source is unchanged — `applyPatch` still
  throws its typed errors and rolls back wholesale (hellgate case
  "applyPatch still THROWS wholesale on a bad hunk").
- The new behaviour is reachable ONLY through the new `applyPatchStructured`
  export. No existing caller (the `apply_patch` tool, the fast-apply fallback)
  calls it, so the dispatch path is byte-identical until a human wires the
  opt-in surface (Integration TODOs).

## Consequences

- A future tool flag / sibling tool can surface partial-success edits and feed
  `messageForModel` back into the next turn for self-correction.
- `applyPatchStructured` reads each op's file twice (before + after) when an op
  succeeds — acceptable: it is invoked only on the opt-in path, and the reads go
  through the same jailed port.
- Because each op is a separate `applyPatch` call, cross-op atomicity is
  deliberately abandoned on this path. This is documented and intentional —
  callers that need wholesale atomicity keep using `applyPatch`.

## Negative invariants

- MUST NOT change `applyPatch` / `parsePatch` / `applier.ts` semantics — the
  throwing path is the security-atomic default.
- MUST NOT import `@/tool` (or any slice above `@/shared`) into `@/patch` — jail
  breaches are recognised structurally.
- `applyPatchStructured` MUST NOT throw for any input, including a non-`Patch`
  argument (encoded as `err`) and a misbehaving port whose method rejects
  (captured as that op's per-file failure).
- `messageForModel` MUST NOT emit patch text, file content, or anchor lines —
  only categorical failure + path + the applier's short detail.
- A FAILED op MUST leave its file's prior on-disk content intact (no partial
  write of that file).

## Test

`tests/unit/patch-structured-apply-hellgate.test.ts` — 14 cases: happy
multi-file (all 3 change types + before/after capture), move → modified +
movedTo + after-at-destination, per-file isolation (bad hunk → that file carries
messageForModel while siblings before AND after it still apply + prior content
intact), jail violation isolated (structural breach), delete-of-missing isolated,
no-throw on non-`Patch` input, no-throw on a port whose write rejects,
messageForModel mapping for every typed error kind + unknown fallback, and the
DEFAULT-OFF byte-identity anchor proving `applyPatch` still throws wholesale.
