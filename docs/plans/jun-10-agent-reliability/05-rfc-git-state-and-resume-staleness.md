# RFC-05: Git Operational-State Awareness + Crash-Resume Tree Staleness

**Status:** PROPOSED · **Priority:** P1 · **Axis:** 4 (충돌/동시성) + 6 (실패 UX 일부)

## Problem statement

Two flavors of the same defect — **the agent acts on a tree whose state it doesn't know**:

1. **Mid-operation git states are invisible.** If the user is mid-rebase / mid-merge / mid-cherry-pick, the working tree contains conflict markers, detached HEAD, half-applied commits. The agent starts a turn, reads that tree, and edits it as if it were normal. Only one narrow corner is covered today (shadow-odb *rewind* refuses on `MERGE_HEAD`) — turn-start has zero awareness, and rebase/cherry-pick aren't detected anywhere at all.
2. **Crash-resume reinjects into a possibly-changed tree.** The resume marker carries task text + partial progress only. Between crash and resume the user may have edited, committed, switched branches — the resumed model continues with assumptions from the dead session. Worse, `ReadFileState` (the stale-guard's mtime baselines) is in-memory and lost on crash, so after resume the stale-guard is **blind** (everything is "unread" = allowed) exactly when the risk of stale assumptions is highest.

## Evidence (R1 found; R2 adversarially confirmed all three; R3 added the ReadFileState loss)

- **MERGE_HEAD only, rewind only:** `src/storage/shadow-odb/default.ts` (~490-505) checks `.git/MERGE_HEAD` before rewind (`allowDirtyMerge` override). Zero references to `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `BISECT_LOG` anywhere in `src/` (grep-confirmed).
- **Env block doesn't cover it:** `probeTurnEnv` (`src/agent/env-context.ts`) captures `git status --porcelain=v2 --branch` — porcelain v2 reports file status + ahead/behind, **not** operation-in-progress state. So even with the env block ON, the model is never told "rebase in progress".
- **Crash-resume marker schema:** `PersistedInterruptedTurn` = `{userText, partialAssistantText, reason, interruptedAt}` (`src/session/types.ts:82-91`). Resume message built purely from these (`src/session/crash-resume.ts:178-184`); offer/reinject path adds nothing (`src/runner/orchestrate/crash-resume-wire.ts:60-76`, consumer `src/apps/cli/repl.ts:1058-1080`). No git/mtime/freshness data anywhere in the flow. Gates: `QUANTA_CRASH_RESUME`, `QUANTA_CRASH_RESUME_PARTIAL` (both default-OFF).
- **ReadFileState not persisted:** state lives in-memory (`src/tool/stale-read-guard/state.ts`); nothing serializes it into the marker or session store. Post-resume, prior reads have no baselines → stale-guard cannot block clobbers of files read before the crash (R3 finding 6A).
- **Worktree merge-back (secondary):** `src/tool/worktree/index.ts:133-180` offers exit/status but no merge operation; a subagent merging back goes through raw bash — conflicts surface as unstructured bash output only.
- Existing strengths to build on (verified-OK): partial flush at `tool.invoked` boundaries is already event-driven and bounded; the env block is the established per-turn host-state channel (ADR-0397).

## Goals

1. The model knows, at turn start, when the repo is mid-operation (rebase/merge/cherry-pick/bisect) — and destructive helpers (rewind) refuse consistently across all those states.
2. A resumed session knows what changed while it was dead, and the stale-guard regains its baselines (or explicitly forces re-reads).
3. (Secondary) worktree merge-back conflicts surface structurally.

## Non-goals

- Blocking all work during rebase (the user may *want* help resolving conflicts — the point is informed behavior, not refusal).
- Cross-process live coordination between two concurrent CLI processes on one repo (accepted limitation; disk-mirror file-lock already serializes persistence — `src/agent/session-resource-registry/disk-adapter/file-lock.ts`).
- Auto-resolving conflicts.

## Workstreams (ticket-able)

### W1 — Git op-state probe (pure detector)
Pure function `detectGitOpState(repoRoot)` → `{op: "rebase" | "merge" | "cherry-pick" | "bisect" | "revert" | undefined, detail}` by stat-ing the canonical `.git` markers (`rebase-merge/`, `rebase-apply/`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `BISECT_LOG`, `REVERT_HEAD`). Worktree-aware (`.git` file indirection for linked worktrees). Lives next to the existing git plumbing; no exec, fs-stat only.

**Acceptance:** unit fixtures per state incl. linked-worktree `.git` files; non-git dir → undefined, no throw.

### W2 — Turn-start surfacing via env block
Extend the per-turn env block (ADR-0397 channel, `src/agent/env-context.ts`) with the W1 result: one line, e.g. `git: rebase in progress (3 conflicts unresolved)` (conflict count from porcelain v2 `u` lines, already parsed). Rides the env block's existing gate/posture — when env block is off, prompt is byte-identical.

**Acceptance:** env-context unit tests for each op state; absent op → byte-identical block.

### W3 — Destructive-helper consistency
Shadow-odb rewind family extends its `MERGE_HEAD` check to all W1 states (same `allowDirty*` override shape). Audit other destructive helpers (file-history rewind, checkpoint three-way restore `src/agent/per-tool-checkpoint/three-way-restore.ts`) for the same blind spot — fix or explicitly document why each is safe.

**Acceptance:** rewind refuses under rebase fixture with typed error; override still works; audit notes land in the ADR.

### W4 — Crash-resume workspace snapshot + drift report
Extend the marker (additive fields; old markers stay readable) with a cheap workspace fingerprint at interrupt time: `{headSha, branch, dirtyPaths: string[] (bounded), opState}` — captured in the same `tool.invoked` flush that already writes partials (`attachCrashResumePartial`). On resume, recompute and inject a deterministic drift section into the resume message: "since interrupt: HEAD moved a1b2→c3d4, 4 files changed (list), branch switched". Non-git or fingerprint-failure → degrade to today's message (no-throw).

**Acceptance:** unit: marker round-trip with/without new fields; integration: crash → external commit → resume message contains drift lines; non-git cwd → byte-identical legacy message. Rides existing `QUANTA_CRASH_RESUME` gates.

### W5 — ReadFileState across crash
Persist the read-baseline map (bounded: the existing range-dedup cap is 8192; persist path→mtime only) in the marker flush; on resume, rehydrate **and** invalidate entries whose current mtime already moved (those become "stale-on-arrival" → first write attempt denies, forcing a re-read). Alternative considered and rejected: forcing re-read of everything via prompt text — unenforced, token-costly.

**Acceptance:** hellgate: read file → crash → external modify → resume → edit attempt **denies stale**; unmodified file → edit proceeds. Size-bound test at the cap.

### W6 — (Secondary) structured worktree merge-back
Add a merge-back operation to the worktree tool (or a structured wrapper) that reports `{merged, conflicts: [{path, kind}]}` instead of raw bash output, so subagent lanes and RFC-07 summaries can show conflict state. Default-OFF with the worktree tool's existing gating.

## Risks

- W4/W5 grow the marker file — bounded fields + caps; flush cadence unchanged (piggybacks existing boundary).
- W5 rehydration must not resurrect baselines for a *different* checkout (branch switch) — fingerprint mismatch (W4's headSha) invalidates the whole map, fail-safe toward forcing re-reads.
- W2 adds prompt bytes per turn — one line, only when an op is actually in progress.

## Relations

- Completes ADR-0528/0529 (crash-resume) and ADR-0474 (stale-guard) story; complements RFC-04 (same control, different hole).
- Feeds RFC-07: opState + drift belong in pre-handoff summaries.
