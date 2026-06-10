# RFC-04 (FINAL): BUGFIX — Write-Path Stale-Guard Integrity (worktree divergence + uncovered base tools)

**Status:** FINAL · **Priority:** P0 (defects in a default-ON safety control) · **Axis:** 4 (충돌/동시성)
**R4 revision:** scope widened — the original worktree key-mismatch is one of THREE holes in the same control, and the worktree fix must cover the write *target*, not just the guard key.

## Problem statement

The stale-read guard (ADR-0474, **default-ON**) is the primary defense against user↔agent concurrent edits. R2 confirmed a worktree key-mismatch false negative in apply_patch/write; R4's bundle review then found the deeper truth — the write class has **three integrity holes**:

1. **`scripted_replace` has no guard at all.** It is a BASE tool (always registered), mutating, and writes with zero `readFileState`/`guardWrite` integration. The TOCTOU control is bypassed on every scripted_replace write, worktree or not. This is strictly worse than the original finding.
2. **apply_patch/write diverge from read under an active worktree — on BOTH the guard key and the write target.** Read resolves through `resolveEditBase(…, ctx.activeWorktree)`; apply_patch jails through `ctx.cwd` and write stats/commits via `ctx.cwd`. Fixing only the guard lookup (the original W1/W2 wording) would leave the *write itself* landing on the session-root copy while read saw the worktree copy — guard "fixed", wrong file still written.
3. **`notebook_edit` (gated) has the guard but keys/writes via raw `ctx.cwd`** — same worktree divergence class.

A safety control that reports itself ON while not covering the write class is worse than an absent control.

## Evidence (R1 → R2 adversarial trace → R4 bundle review; all anchors re-verified against the working tree)

- **Read records worktree-resolved paths:** `src/tool/read/index.ts:305` (`resolveEditBase(input.path, ctx.cwd, ctx.activeWorktree)`) → records resolved absolute path at `:515`. The comment at `read/index.ts:295-304` documents the path-identity invariant this RFC restores.
- **Edit is correct (the reference implementation):** `src/tool/edit/index.ts:473` resolveEditBase → `editPreCommitDeny`/`guardWrite` at `:403-411`; commit goes to the same resolved target.
- **scripted_replace:** `src/tool/surface/manifest.ts:109` (BASE_TOOL_NAMES member), `src/tool/scripted-replace.ts:305` (`writeFile(input.file, r.next, ctx.cwd)`); zero occurrences of `readFileState`/`guardWrite`/`resolveEditBase` in the file (grep-verified).
- **apply_patch:** `src/tool/apply-patch.ts:624` `FsJailFileSystemPort({jailRoot: ctx.cwd})`; `guardStaleTargets` at `:423-449` checks `resolveJailed(op.path, ctx.cwd)`; apply itself goes through the same ctx.cwd jail. apply_patch's own doc comment (`:419-421`) asserts the read/write path-identity invariant that worktrees break. Zero `resolveEditBase`/`activeWorktree` in file.
- **write:** `src/tool/write/index.ts:16-31` `staleWriteGuard` stats via `ctx.cwd`; commit writes via `fs.writeFile(input.path, ctx.cwd)`. Zero worktree references.
- **notebook_edit:** has `guardWrite` (`src/tool/notebook-edit/tool.ts:125`) but stats/writes via raw `ctx.cwd`.
- **Reachability:** `src/agent/dispatch.ts:870-879` threads `activeWorktree` to all tools; nothing removes these tools in worktree contexts.
- **Concrete false-negative trace (R2):** worktree active; model reads `relative/file.ts` → state records `<worktree>/relative/file.ts`; external edit bumps mtime; apply_patch update on `relative/file.ts` → guard checks `<sessionRoot>/relative/file.ts` → key miss → "unread" → allowed. With H2 understood: even when allowed legitimately, the write lands on `<sessionRoot>/…` — a different file than the one read.

## SOTA alignment (R4 corpus)

Claude Code enforces read-before-edit + content-hash staleness at the **tool layer** (corpus: changelog v1.303 "File content has changed" rejection; Bash warns when a formatter modifies previously-read files) — the strongest competitor mechanism on this axis, and the invariant class quanta's stale-guard mirrors. Cursor relies on VSCode buffer-level `concurrent_edits`; Codex has nothing verified. **None of the three run layered worktree-aware agents writing through two roots — this hazard is self-inflicted by quanta's richer write surface, and this fix restores the CC-grade invariant across all of it.** No absorb candidates; the exceed criterion is simply: guard coverage = write class, structurally enumerated (W3), which no competitor needs and none has.

## Goals

1. **Every** mutating file-writing tool consults `ReadFileState` through the **same resolution read used** — and writes to that same resolved target (full worktree fence, not key-only).
2. The write class is **structurally enumerated** (derived from the manifest), so a future write tool cannot ship outside the control.

## Non-goals

- Changing unread-allowed semantics, gate defaults, jail behavior.
- Cross-process coordination (RFC-05 territory / accepted limitation).
- `moveTo` stale-checking (moves are not stale-checked today even without worktrees — `apply-patch.ts:431` skips non-update/delete ops; tracked as an explicit semantic addition inside W1, with its own control test, not silently bundled).

## Workstreams (ticket-able; see tickets/T-401..406)

### W1 — apply_patch full worktree fence
Resolve every update/delete target (and moveTo destinations) through `resolveEditBase(op.path, ctx.cwd, ctx.activeWorktree)`; stat, `guardWrite`, **and apply** against the resolved path; assert the jail on the resolved path (worktree dirs live under the repo root so `resolveJailed` should pass — assert, don't assume; if the jail excludes the worktree that is a second latent bug to surface, not paper over). moveTo stale-checking is included as a flagged semantic addition.

### W2 — write full worktree fence
`staleWriteGuard` + the commit path both go through `resolveEditBase`, matching edit.

### W3 — scripted_replace stale-guard integration (NEW, the widest hole)
Wire `guardWrite` (pre-commit deny, typed `StaleReadError`) + `resolveEditBase` target resolution into scripted_replace, mirroring edit's contract. This is a behavior change for a base tool: stale scripted_replace writes that silently succeeded will now deny — that is the *intended* restoration of the default-ON control; changelog note required.

### W4 — notebook_edit worktree keying parity
Route its existing `guardWrite` and its write target through `resolveEditBase`.

### W5 — structural write-class hellgate (manifest-derived)
Integration tests, gate ON, `activeWorktree` set, for **each tool in the write class**:
1. read relative path (records worktree path) → external mtime bump → write-class op on the same relative path → **typed stale deny**;
2. allowed-case same-file assertion (H2): without external modification, read→write address the **same file** — byte assertion that the worktree copy changed and the session-root copy is untouched;
3. controls: no-worktree flow byte-identical; brand-new file still allowed (unread semantics preserved).
Plus a structural test that **enumerates the write class from the manifest** (mutating + file-writing) and asserts each member calls the shared resolver/guard seam — a 4-name hardcoded list is exactly how scripted_replace escaped; the enumeration must be derived.

### W6 — mirror-sweep survey (split out of the P0 path)
Survey storage adapters, file-history restore, checkpoint three-way restore for raw-`ctx.cwd` keying against worktree-recorded reads. Survey-only ticket; fixes found spin off individually (keeps the P0 bugfix unblocked by an open-ended sweep).

## Acceptance criteria (bundle-level)

- R2's trace scenario denies on apply_patch, write, scripted_replace, notebook_edit.
- H2 same-file assertion passes for all four under worktree.
- Zero behavior change when `activeWorktree` unset **except** W3's intended stale-deny restoration (pinned by its own test).
- Manifest-derived structural test green; existing stale-guard suites green.

## Risks

- Worktree↔jail interaction (W1 assertion) — tested, not assumed.
- W3 may surface latent stale-write reliance in existing flows — that's the control working; smoke suite is the canary.
- W6 findings could exceed survey scope — by design they become separate tickets.
