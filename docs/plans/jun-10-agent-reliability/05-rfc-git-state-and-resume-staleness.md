# RFC-05 (FINAL): Git Operational-State Awareness + Crash-Resume Tree Staleness

**Status:** FINAL · **Priority:** P1 · **Axis:** 4 (충돌/동시성) + 6 (실패 UX 일부)
**R4 revision:** env-block wiring exposed as built-not-wired → explicit prerequisite workstream; fingerprint capture moved to mark-time; ReadFileState plumbing specced through the composition root; survey/fix split; anchors corrected.

## Problem statement

Two flavors of the same defect — **the agent acts on a tree whose state it doesn't know**:

1. **Mid-operation git states are invisible.** Mid-rebase/merge/cherry-pick trees carry conflict markers, detached HEAD, half-applied commits. The agent reads and edits them as if normal. Today only shadow-odb *rewind* checks `MERGE_HEAD`; rebase/cherry-pick/bisect are detected nowhere, and turn start has zero awareness.
2. **Crash-resume reinjects into a possibly-changed tree.** The marker carries task text + partial progress only; the user may have edited/committed/switched branches between crash and resume. Worse, `ReadFileState` (stale-guard baselines) is in-memory and lost on crash — after resume the guard is **blind** (everything "unread" = allowed) exactly when stale assumptions are most likely.

## Evidence (R1 → R2 confirmed → R4 seam-verified; anchors corrected)

- **MERGE_HEAD only, rewind only:** `src/storage/shadow-odb/default.ts:536-586`. Zero refs to `rebase-merge` / `rebase-apply` / `CHERRY_PICK_HEAD` / `BISECT_LOG` in `src/` (grep-confirmed).
- **Env block can't help yet — built-not-wired (R4-H3):** `probeTurnEnv` (`src/agent/env-context.ts`) captures `git status --porcelain=v2 --branch` (file status + ahead/behind, **not** op state) — and has **zero live callers** (only its hellgate test and the eval grounding probe). The loop's only `buildTurnContext` call (`src/agent/loop/context-assembler.ts:287-317`) never passes `env`; no gate for the block exists in cli-knobs (`QUANTA_ENABLE_ENV_PROBE` is the unrelated shell-probe). ADR-0397 is the repo's known built-not-wired class — wiring is part of this RFC now.
- **Marker schema:** `PersistedInterruptedTurn` = `{userText, partialAssistantText, reason, interruptedAt}` (`src/session/types.ts:82-91`); resume message pure over those fields (`src/session/crash-resume.ts:178-184`); offers add nothing (`src/runner/orchestrate/crash-resume-wire.ts:~84-95`; CLI consumer `src/apps/cli/repl.ts:~313-340`). Gates `QUANTA_CRASH_RESUME` / `QUANTA_CRASH_RESUME_PARTIAL`, both default-OFF.
- **ReadFileState reachability (R4-M3):** constructed in `src/host/runtime/agent-config-assembler.ts:580` behind the `RuntimeSession` boundary; the flush caller (`src/runner/orchestrate/session-turn-driver.ts:153`) sees only `{sessionId, userText, env}` + events. Persistence needs a capability threaded from the composition root that owns both. Also: `DEFAULT_RANGE_DEDUP_CAP = 8192` bounds the H9 **range-dedup** map — documented as orthogonal to the freshness `mtimes` map, which is unbounded; W5 defines its own bound.
- **Flush seam has no git access (R4-M4):** the `tool.invoked` flush is an injectable `flushImpl`; running `git status` per tool boundary is per-call exec cost. Mark-time capture (once per turn at `withCrashResumeMarker`, `crash-resume-wire.ts:60-76`) is sufficient for drift-vs-resume.
- **Worktree merge-back:** `src/tool/worktree/index.ts:133-180` — exit/status only; merge goes through raw bash, conflicts unstructured.

## SOTA alignment (R4 corpus)

- **Cursor runs runtime git op-state polling — direct precedent for W1/W2.** `checkMergeStatus` stats `.git/MERGE_HEAD` and `checkRebaseStatus` polls `.git/rebase-merge` / `.git/rebase-apply`, tracking transitions with commit-hash deltas (`cursor-always-local/dist/main.js:208675, 208686`). Cursor uses it for event logging; surfacing it to the *agent prompt* (W2) already exceeds.
- **Claude Code:** worktree branch-source documentation only; no runtime adaptation to merge/rebase state found.
- **Codex:** `prepare-worktree-snapshot` / `upload-worktree-snapshot` tools (`codex/.vite/build/src-B5wXNbcV.js:12210-12211`) — precedent for structured multi-agent merge-back (W6).
- **Nobody fingerprints workspace state at interrupt and reports drift on resume** (Cursor's `resumeAgentId` is continuation-only). W4/W5 are exceed-class.

## Goals

1. The model knows at turn start when the repo is mid-operation; destructive helpers refuse consistently across all such states.
2. A resumed session knows what changed while it was dead; the stale-guard regains its baselines.
3. (Secondary) worktree merge-back conflicts surface structurally.

## Non-goals

- Blocking work during rebase (the user may want conflict help — informed behavior, not refusal).
- Cross-process live coordination between concurrent CLIs (accepted; disk-mirror file-lock already serializes persistence).
- Auto-resolving conflicts.

## Workstreams (ticket-able; see tickets/T-501..508)

### W1 — Git op-state probe (pure detector)
`detectGitOpState(repoRoot)` → `{op: "rebase"|"merge"|"cherry-pick"|"bisect"|"revert"|undefined, detail}` by stat-ing `.git` markers (`rebase-merge/`, `rebase-apply/`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `BISECT_LOG`, `REVERT_HEAD`); worktree-aware (`.git` file indirection). fs-stat only, no exec, no-throw (non-git → undefined). Mirrors Cursor's verified mechanism, as a pure function.

### W2 — Env-block wiring closeout + op-state line (PREREQUISITE INCLUDED)
Two-part ticket, explicitly bigger than "add one line":
(a) **Wire ADR-0397:** thread `probeTurnEnv` output into the live context assembly (`context-assembler.ts:287-317` → `buildTurnContext` env input), behind a new registered gate (knob registry + `--help`), default decision argued in the ticket (proposal: default-OFF initially, matching the block's original ADR posture; flip evaluated after bake-in).
(b) **Op-state line:** extend the block with W1's result — `git: rebase in progress (3 conflicts unresolved)` (conflict count from porcelain v2 `u` lines, already parsed). One line, only when an op is active.

**Acceptance:** live e2e showing the block in a real turn; per-op-state unit fixtures; gate OFF → byte-identical prompt.

### W3a — Destructive-helper survey · W3b — fixes
(a) Survey shadow-odb rewind family, file-history rewind, checkpoint three-way restore (`src/agent/per-tool-checkpoint/three-way-restore.ts`) for op-state blind spots; document safe/unsafe per helper. (b) Extend checks to all W1 states (same `allowDirty*` override shape) where the survey says unsafe. Split per R4-L4 so the unbounded survey doesn't gate the bounded fixes.

### W4 — Crash-resume workspace fingerprint + drift report (mark-time)
Capture `{headSha, branch, dirtyPaths (bounded), opState}` **once per turn at `withCrashResumeMarker` mark-time** (composition root wires the git access into the marker args — the flush seam stays git-free). On resume, recompute and inject a deterministic drift section: "since interrupt: HEAD a1b2→c3d4, 4 files changed (list), branch switched". Non-git / probe failure → today's message (no-throw). Additive marker fields; old markers readable.

**Acceptance:** marker round-trip ± new fields; crash → external commit → resume message carries drift; non-git → byte-identical legacy. Rides existing `QUANTA_CRASH_RESUME` gates.

### W5 — ReadFileState across crash (capability-plumbed)
Composition root (which owns both the assembler at `agent-config-assembler.ts:580` and the session) threads a `snapshotReadBaselines(): ReadonlyArray<{path, mtimeMs}>` capability into the marker flush args. Persist bounded path→mtime baselines (own bound, e.g. most-recent-N — the 8192 range-dedup cap is a different map and not reused); on resume rehydrate and **invalidate stale-on-arrival** entries (current mtime moved → first write denies, forcing re-read). Whole-map invalidation when W4's headSha mismatches (branch switch ⇒ all baselines suspect — fail toward re-reads). Thin-client/remote sessions without the capability degrade to today (no baselines).

**Acceptance:** hellgate: read → crash → external modify → resume → edit **denies stale**; unmodified → proceeds; headSha-mismatch → all invalidated; bound respected at cap.

### W6 — (Secondary) structured worktree merge-back
Merge-back operation on the worktree tool reporting `{merged, conflicts: [{path, kind}]}` instead of raw bash output (Codex worktree-snapshot tools as precedent). Default-OFF with the worktree tool's gating.

## Risks

- Marker growth — bounded fields, mark-time cadence (one probe per turn).
- W5 must not resurrect baselines for a different checkout — headSha fence (fail-safe to re-reads).
- W2(a) default flip risk — start OFF, measured flip.

## Relations

- Completes ADR-0528/0529 + ADR-0474 + ADR-0397 stories; complements RFC-04 (same control, different holes).
- Feeds RFC-07 (opState + drift in pre-handoff summaries).
