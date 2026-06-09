# RFC-04: BUGFIX — Stale-Read-Guard False Negative for apply_patch/write Under Active Worktree

**Status:** PROPOSED · **Priority:** P0 (defect in a default-ON safety control) · **Axis:** 4 (충돌/동시성)

## Problem statement

The stale-read guard (ADR-0474, **default-ON**) is the primary defense against user↔agent concurrent edits: read records a file's mtime, write-class tools refuse to clobber a file that moved underneath the model. That guarantee silently breaks when a worktree is active: **read records the worktree-resolved path, but apply_patch and write check a differently-resolved path**, so the guard looks up the wrong key, finds "unread" (which is allowed by design), and lets a stale write through. A safety control that reports itself ON while not covering two of the three write paths is worse than an absent control.

## Evidence (R1 found, R2 adversarially confirmed with a concrete trace, main-loop grep re-verified zero `resolveEditBase`/`activeWorktree` references in the two files)

- **Read records worktree-resolved paths:** `src/tool/read/index.ts:515` calls `resolveEditBase(input.path, ctx.cwd, ctx.activeWorktree)` and records `outcome.info.path` (fully resolved, worktree-aware) into `ReadFileState`.
- **Edit checks the same resolution — correct:** `src/tool/edit/index.ts:473` (`resolveEditBase`) → `editPreCommitDeny` → `guardWrite(ctx.readFileState, target.path, …)` at `index.ts:408-411`. Edit is NOT affected.
- **apply_patch resolves through the session jail only:** `src/tool/apply-patch.ts:624` constructs `FsJailFileSystemPort({ jailRoot: ctx.cwd })`; `guardStaleTargets` (`apply-patch.ts:423-449`) checks `guardWrite(state, stat.resolvedPath, …)` where `resolvedPath = resolveJailed(op.path, ctx.cwd)` — **not worktree-resolved**.
- **write uses ctx.cwd only:** `src/tool/write/index.ts:16-31` `staleWriteGuard` stats via `fs.statFile(path, ctx.cwd)`; zero `activeWorktree` references in the file.
- **apply_patch IS reachable with an active worktree:** `src/agent/dispatch.ts:870-879` threads `activeWorktree` to all tools; no filtering removes apply_patch/write inside worktree contexts.
- **Concrete false-negative trace (R2):** session cwd `/repo`, active worktree `/repo/.claude/worktrees/agent-x`, model reads `relative/file.ts` → state records `/repo/.claude/worktrees/agent-x/relative/file.ts`. User (or another lane) modifies that file. Model calls apply_patch on `relative/file.ts` → guard checks `/repo/relative/file.ts` → key miss → `unread` → **allowed**. Stale clobber.
- Unread-allowed semantics (`src/tool/stale-read-guard/state.ts:186-192`) are correct by design for genuinely-new files; the bug is purely the key mismatch.

## Goals

1. All three write paths (edit / write / apply_patch) consult `ReadFileState` with the **same path resolution read used**.
2. Pin the invariant with hellgate tests so future path-resolution changes can't silently reintroduce the split.

## Non-goals

- Changing unread-allowed semantics, gate defaults, or jail behavior.
- Cross-process coordination (separate concern; RFC-05/accepted limitation).

## Workstreams (ticket-able)

### W1 — apply_patch worktree-aware stale check
In `guardStaleTargets` (`src/tool/apply-patch.ts:423-449`), resolve each update/delete target through `resolveEditBase(op.path, ctx.cwd, ctx.activeWorktree)` before stat + `guardWrite`, matching edit. Note the jail boundary must still be enforced on the **resolved** path (worktree dirs live under the repo root, so `resolveJailed` of the worktree-resolved path should pass; assert it rather than assume — if the jail root excludes the worktree, that's a second latent bug to surface, not paper over). Also check `moveTo` targets for consistency.

### W2 — write worktree-aware stale check
`staleWriteGuard` (`src/tool/write/index.ts:16-31`): resolve via `resolveEditBase` (path + base) before `fs.statFile`, matching edit. Mirror-sweep per house rule: confirm no other write-class path (storage adapters, file-history restore) records/checks raw `ctx.cwd` keys against worktree-recorded reads.

### W3 — Hellgate: resolution-parity invariant
Integration test, gate ON (default), `activeWorktree` set:
1. read `relative/file.ts` (records worktree path);
2. mutate the file externally (bump mtime);
3. apply_patch update + write to the same relative path → **both must deny stale**;
4. control: same flow without worktree → unchanged behavior;
5. control: brand-new file under worktree → still allowed (unread semantics preserved).
Plus a structural test asserting edit/write/apply_patch all call the same resolver seam (anti-regression for the *class*, not just the instance).

## Acceptance criteria

- The R2 trace scenario denies with the typed `StaleReadError` on both apply_patch and write.
- Zero behavior change when `activeWorktree` is unset (byte-identical results on the existing suites).
- Existing stale-guard unit/hellgate suites stay green; new hellgate added to `tests/`.

## Risks

- Worktree path vs jail root interaction (W1 note) — must be tested, not assumed.
- File-history/checkpoint subsystems may key by the unresolved path; W2's mirror-sweep covers the survey, fixes there spin off as follow-up tickets if found.

## Relations

- Defect in ADR-0474 implementation surface; small diff, ships ON (it repairs an existing default-ON control, not new behavior).
- Related: RFC-05 (other concurrency gaps), jun-09 mirror-check lesson (edit-class fixes must sweep storage/apply_patch mirrors).
