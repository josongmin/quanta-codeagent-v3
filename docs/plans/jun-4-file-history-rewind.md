# RFC: N5 — File-History Rewind (per-file session undo)

- **Status:** Draft (design doc — NOT an implementation)
- **Date:** 2026-06-04
- **Author:** Jo
- **Proposed ADR:** 0477 (next free; 0476 is the current high-water mark)
- **Feature id:** N5
- **Posture:** Default-OFF seam, opt-in tool + CLI, no hot-path mutation

---

## 1. 요약 (Summary)

N5 wants a tool that reverts **one specific FILE** to a **prior version captured earlier in the
session** — a per-file undo, an implicit mini-VCS over the agent's own edits. The model (or a
human via CLR) names a file, sees its timestamped history, and restores it to a chosen point
WITHOUT touching any other file and WITHOUT a manual `git revert` dance.

**The central question is overlap**, and the audit answers it decisively (§3):

> **Verdict: N5 is a GENUINE NEW per-file-history layer, NOT a surface wrapper over shadow-ODB.**
>
> quanta's shadow-ODB already does *whole-tree* snapshotting and even has a *path-scoped restore*
> (`restorePartial(paths)`), but that path-scoped restore can ONLY pull files from the **single
> most-recent snapshot** (`SHADOW_LAST_REF`). There is **no API anywhere** — not in `ShadowOdb`,
> not in the ADR-0205 three-way-restore — that restores a **named file to an arbitrarily-chosen
> PRIOR snapshot**. The "version axis × file axis" intersection is empty today. That intersection
> IS N5.

The design (§4) is therefore **option (b): a thin new per-file timestamped-history layer**, built
to **reuse** the shadow-ODB commit graph as its storage (every `registerHead` commit already *is* a
timestamped whole-tree snapshot — we just need to read ONE blob out of an OLDER commit), so we add
the missing "restore file F at commit C" primitive and the file-history index, but **invent no new
storage backend**. This keeps us honest: reuse the bytes, add the one genuinely-missing operation.

---

## 2. 경쟁사 레퍼런스 — Claude Code FileHistory (verified)

**Source:** `.extracted_source/claude-code-cli/_cli-symbols.txt`, lines ~129620–129760. Verified by
direct grep of `tengu_file_history_*` (the 8 `rewind` occurrences cited in the task plus the wider
family). This is the de-minified telemetry/log vocabulary, so the model is reconstructable.

### 2.1 Snapshot model (when / granularity)

| Symbol / log string | What it tells us |
|---|---|
| `FileHistory: Making snapshot for message <id>` | **Snapshots are keyed per CONVERSATION MESSAGE**, not per turn or per tool. Each user/assistant message boundary can produce a snapshot. |
| `tengu_file_history_track_edit_success` / `..._track_edit_failed`, `FileHistory: Tracked file modification for` | Edits are **tracked incrementally** as the agent modifies files (a per-file watch list — `trackedFileBackups`, `trackedFilesCount`). |
| `FileHistory: Added snapshot for` / `tengu_file_history_snapshot_success` | A snapshot records the set of tracked files at that message. `snapshotCount`, `numSnapshots`, `failedSnapshots`. |
| `tengu_file_history_backup_file_created`, `backupFileName`, `backupTime`, `trackedFileBackups` | **Granularity is per-FILE backup blobs.** Each modified file is copied to a backup file (named `backupFileName`, stamped `backupTime`). The snapshot is an INDEX over per-file backups, not a monolith. |
| `tengu_file_history_backup_deleted_file`, `FileHistory: [Rewind] Deleted` | Deletions are modelled too — a file deleted since a snapshot is **re-created** on rewind; a file that didn't exist at the snapshot is **deleted** on rewind. |
| `fileCheckpointingEnabled`, `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` | **Default-ON in the CLI, env-disable + separate SDK opt-in.** A clean knob model to mirror (we will go default-OFF — see §8 risk). |

### 2.2 Restore semantics (rewind)

```
FileHistory: [Rewind] Rewinding to snapshot for <message>
FileHistory: Missing most recent snapshot
The selected snapshot was not found            → tengu_file_history_rewind_failed
FileHistory: Error finding the backup file to apply → tengu_file_history_rewind_restore_file_failed
FileHistory: [Rewind] Backup file not found: <path>
FileHistory: [Rewind] Restored <path>
FileHistory: [Rewind] Deleted <path>
FileHistory: [Rewind] Failed to restore <path>
FileHistory: [Rewind] Finished rewinding to <message>  → tengu_file_history_rewind_success
FileHistory: Error generating diffStats:
```

Restore is **snapshot-anchored** (you rewind the tracked set to the state captured at message *M*),
operates **file-by-file** (each `Restored`/`Deleted`/`Failed to restore` is per path), is **partial-
failure tolerant** (`tengu_file_history_rewind_restore_file_failed` is per-file, the rest proceed),
and emits **diffStats** for the surface. Cross-session: `FileHistory: Copied backup … on restore`
copies prior-session backups forward (`no previous session id` is the missing-anchor case).

### 2.3 What we take vs leave

- **Take:** per-file backup granularity; the index-over-backups model; the per-file restore loop
  with per-path failure isolation; the deleted-file re-creation / never-existed-file-deletion
  semantics; the typed failure vocabulary (`snapshot not found`, `backup file not found`,
  `failed to restore <path>`); diffStats on the restore result.
- **Leave (deliberately differ):** Claude's snapshot key is the *message*. quanta already has a
  *whole-tree commit per checkpoint* (shadow-ODB) plus a *message-rewind* axis (`rewindToMessage`).
  We do NOT add a third independent backup store — we **read prior versions out of the shadow-ODB
  commits we already write** (§4). And we go **default-OFF** rather than Claude's default-ON.

---

## 3. 현재 quanta 상태 — OVERLAP MATRIX (the key deliverable)

Four mechanisms touch "undo" in quanta. The question N5 forces: **does any of them restore a
NAMED FILE to an ARBITRARY PRIOR VERSION?** Evidence cited file:line.

### 3.1 Overlap matrix

| Mechanism | Granularity | Trigger | Restore axis | Can restore ONE file? | Can target an ARBITRARY prior version? | Verdict for N5 |
|---|---|---|---|---|---|---|
| **shadow-ODB** `ShadowOdb` (`src/storage/shadow-odb/types.ts`, `default.ts`; ADR-0108/0119/0121/0122) | **Whole-tree** git commit per snapshot | `registerHead()` — manual, or auto via checkpoint-policy (`src/agent/checkpoint-policy.ts`) per-mutating / pre-destructive / per-turn | `rewindToLast` (→ `SHADOW_LAST_REF`), `rewindToVerified` (→ `SHADOW_LAST_VERIFIED_REF`), `restorePartial(paths)` | **YES** — `restorePartial` (types.ts:111-139) restores ONLY named paths | **NO** — `restorePartial` targets `SHADOW_LAST_REF` only (types.ts:111-112, restore-partial.ts:1-5); `rewindTo*` target two fixed refs. `listSnapshots` enumerates older refs but **no API consumes an older ref to restore from** | **Storage REUSE; missing the version-selection primitive** |
| **per-tool-checkpoint / 3-way restore** `ThreeWayRestorePort` (`src/agent/per-tool-checkpoint/port.ts` + `three-way-restore.ts`) | Tagged whole-tree anchors (`GranularRegistry`, tag→SHA) | Auto via granular policy on tool calls | `restoreFiles(tag)` / `restoreTask` / `restoreBoth` | **NO** — files leg is whole-tree | **NO** — `restoreFiles(tag)` resolves the tag's SHA **but then calls `rewindToLast`, IGNORING the SHA** (`three-way-restore.ts:106-112`: *"Today we use `rewindToLast` (which targets `SHADOW_LAST_REF`) rather than [the tag's sha]"*) | **Confirms the gap: even the tagged-history surface can't restore an older version** |
| **stale-read-guard** (`src/tool/stale-read-guard/state.ts`, ADR-0474, jun-04) | Per-file **mtime** map | Recorded at READ time | none (gate only — `guardWrite` blocks stale writes) | n/a — tracks **freshness, not content** | **NO history at all** | **Orthogonal — must coordinate (§8), not overlap** |
| **rewindToMessage** (`src/session/store.ts:528`) | **Conversation** messages | message-id rewind UX | rewinds the `Message[]`, re-persists session | n/a — **no file content** | **NO** — conversation only | **Different axis (task, not files)** |
| **git tools** (`src/tool/git/*`: `diff`, `commit`, `stage`, `branch-switch`, …) | User's real repo | explicit agent/user invocation | full VCS | YES via `git checkout <sha> -- <file>` | YES — but **NOT session-implicit**; pollutes user index/reflog; requires the file to be committed; HARD_DENY guards destructive ops | **Not the implicit per-edit undo N5 wants** |

### 3.2 The precise verdict (read carefully)

**`shadow_restore_partial` does NOT already provide per-file-restore-to-a-prior-version.** Two
independent reads prove it:

1. **`ShadowOdb.restorePartial`** (`src/storage/shadow-odb/types.ts:111-139`) — its contract is
   verbatim *"Restore ONLY the given paths from the **last registered** snapshot
   (`SHADOW_LAST_REF`)."* There is **no ref / sha / timestamp parameter**. It is "named files ×
   *the* last snapshot", a single point on the version axis.

2. **`ThreeWayRestorePort.restoreFiles(tag)`** (`src/agent/per-tool-checkpoint/three-way-restore.ts:106-156`)
   — this is the closest thing to "restore from a chosen historical anchor", and it *resolves the
   tag's SHA* (line ~90-98) — but the comment at lines 106-112 admits: *"Today we use `rewindToLast`
   (which targets `SHADOW_LAST_REF`) rather than [restoring at the tag's sha]… [because the slice]
   forbids touching `src/storage/shadow-odb/*`."* So even the tagged-history surface throws the
   chosen version away and restores the latest. And it is **whole-tree**, not per-file.

The shadow commit graph **physically contains** every prior version of every file (each
`registerHead` is a whole-tree commit; `listSnapshots` enumerates them newest-first with
timestamps — `types.ts:98-101, 249-258`). The **bytes exist**; what is missing is the single
operation *"git --git-dir=<shadow> checkout <commitC> -- <fileF>"* exposed as a closed-port method
plus an index that maps `(file → [versions])` so the model can pick a version without knowing git
SHAs.

**Conclusion:** N5 = (existing shadow commit graph as storage) + (ONE new `ShadowOdb` primitive:
restore-file-at-ref) + (a per-file history projection over `listSnapshots`) + (a thin tool + CLI).
This is a **new layer**, not a UX wrapper — but it is a *thin* new layer that reuses ~90% of the
machinery already on disk.

---

## 4. 설계 (Design) — option (b), justified

Per §3 the overlap verdict picks **(b) a new per-file timestamped-history layer**, deliberately
constructed to **reuse the shadow-ODB commit graph as the snapshot store** rather than introducing
a parallel backup directory (Claude's `trackedFileBackups` model). Justification:

- We already write whole-tree commits on a cadence (checkpoint-policy). Adding a second per-file
  backup store would **double the storage** and create a coherence problem (which store is truth?).
- Reading one blob out of an existing commit (`git cat-file` / `git checkout <sha> -- <path>`) is
  cheap, deterministic, and inherits all of shadow-ODB's path-safety invariants for free.
- The *only* genuinely-new operation is "checkout one path from an arbitrary ref", which today's
  ports refuse to expose. We add exactly that, nothing more.

### 4.1 New closed-port primitive on `ShadowOdb`

```
// src/storage/shadow-odb/types.ts — ADDITIVE, default callers unaffected
interface ShadowOdb {
  // ... existing ...

  /** History of one path: the subset of snapshot refs whose tree contained
   *  <path>, with that ref's blob sha + timestamp, NEWEST first. Pure read.
   *  Repo-relative path; rejects absolute / `..` (same posture as restorePartial). */
  fileHistory(workspaceRoot: string, path: string): Promise<readonly FileVersion[]>

  /** Restore ONE path to the version captured by <ref> (a ref name returned by
   *  fileHistory / listSnapshots). All other files untouched. Pre-rewind
   *  safety-net ref is taken BEFORE the write (same as restorePartial). When
   *  <path> did not exist at <ref> → policy per opts.onAbsent
   *  ("delete" to match Claude's never-existed semantics | "error" default). */
  restoreFileAtRef(
    workspaceRoot: string,
    path: string,
    ref: string,                      // validated against the shadow refs allow-list — NO arbitrary ref injection (HELL-14 posture)
    opts?: RestoreFileOptions,
  ): Promise<RestoreFileResult>
}

interface FileVersion {
  readonly ref: string          // refs/quanta/snapshots/...  (allow-listed)
  readonly blobSha: string      // git blob id of <path> at this snapshot
  readonly timestampSec: number // committerdate:unix
  readonly bytes: number        // blob size — surface can show "12.3 KB"
}
```

Crucially `ref` is **not** a free-form git ref: `restoreFileAtRef` re-validates it against
`listSnapshots`' output (refs under `refs/quanta/snapshots/`) before any git call, preserving the
hard-coded-ref-prefix anti-injection posture of the existing slice (`types.ts:216-235`).

### 4.2 The N5 tool — `file_rewind`

A thin tool in `src/tool/file-history/` (sibling to `src/tool/shadow/`), plane-clean (imports only
`@/storage/shadow-odb`, `../types`, `zod`), mirroring `shadow_restore_partial`'s envelope exactly:

```
file_rewind {
  path: string,                       // repo-relative; required
  to?: string,                        // a ref from `file_history`; default = the SECOND-newest
                                      //   snapshot containing <path> (i.e. "undo my last edit")
  onAbsent?: "delete" | "error",      // default "error"
}
file_history {                        // read-only companion (lists versions for one file)
  path: string,
  limit?: number,                     // default 20
}
```

- `file_history` → `isReadOnly: true`, `isConcurrencySafe: true`. Renders
  `N. <ISO-timestamp>  <blobSha[:12]>  <bytes>` per version (deterministic; same fmt as
  `shadow_snapshots`).
- `file_rewind` → `isReadOnly: false`, `isConcurrencySafe: false`, `hitlTier: "always-confirm"`
  (destructive on the named file — identical posture to `shadow_rewind` / `shadow_restore_partial`).
  Every `ShadowOdbError` collapses to `ok:false` with `output` prefixed by the typed code; non-typed
  throws bubble (the `_shared.safeRun` convention used by every shadow tool).

**Why a NEW tool rather than extending `shadow_restore_partial`:** adding a `ref`/`version` param to
`shadow_restore_partial` would change its byte-stable signature (drift guards + hellgate pin it) and
conflate "restore many paths from THE last snapshot" with "restore ONE path from A CHOSEN version".
Different mental model, different default, different blast radius → separate tool, like Claude keeps
`rewind` distinct from `track_edit`.

### 4.3 Default selection ("undo my last edit") without git literacy

The model rarely knows snapshot SHAs. So `file_rewind` with no `to` defaults to the **second-newest
snapshot that contains the file** — i.e. "the version before the most recent change". This makes the
common case (`file_rewind {path}` = "undo what you just did to this file") a one-arg call, matching
the ergonomics of Claude's message-anchored rewind while staying file-scoped.

### 4.4 Diff on result (parity with Claude's diffStats)

`restoreFileResult` carries `{ ok, restored: boolean, deleted: boolean, fromRef, unifiedDiff?,
bytesBefore, bytesAfter }`. The tool renders a one-line summary + (capped) unified diff so the model
sees exactly what changed, mirroring `tengu_file_history_rewind` `diffStats`.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF)

New env flag, following the `STALE_READ_GUARD_ENV` precedent (`src/tool/stale-read-guard/gate.ts`):

```
QUANTA_FILE_HISTORY_REWIND = "1"   // opt-in; unset ⇒ tool not registered ⇒ byte-identical
```

Reuses the existing shadow-ODB knobs (no new storage knob): `QUANTA_SHADOW_ODB_MAX_BYTES`
(`types.ts:262`) already bounds the commit graph, and the checkpoint-policy LRU sweep
(`checkpoint-policy.ts:cleanupMaxBytes`) already evicts it. N5 adds **zero** storage growth beyond
what shadow-ODB already produces — it only READS older commits (§8).

### 5.2 Tool-surface manifest (SSOT)

Add a `GATED_TOOLS` row in `src/tool/surface/manifest.ts` (the per-file undo is a *capability* gate):

```
{
  name: "file_rewind",
  group: ["file_history"],
  origin: "@/tool/file-history",
  gate: { kind: "config-slot", slot: "DefaultToolPorts.fileHistory", env: "QUANTA_FILE_HISTORY_REWIND" },
  default: { cli: "opt-in" },          // opt-in everywhere — destructive recovery, not a daily tool
  risk: "mutating",
  adr: "0477",
  note: "Restore ONE file to a prior session snapshot (per-file undo over the shadow commit graph). Opt-in: destructive on the named file; relies on shadow-ODB snapshots existing (needs a checkpoint cadence wired).",
}
```

The bidirectional drift guard (`tests/unit/tool-surface-manifest-hellgate.test.ts`) then forces the
registration to match the SSOT — same mechanism that pins every other GATED tool.

### 5.3 Feature catalog

Add an fc leaf under the recovery/undo axis in `docs/10.feature-catalog.md` (+ the YAML the
`feature-catalog-*` tests validate), cross-referencing shadow-ODB (storage), checkpoint-policy
(cadence), and stale-read-guard (coordination). Mark N5's relationship: **consumes** shadow-ODB,
**sibling-of** `shadow_restore_partial`, **coordinates-with** stale-read-guard.

### 5.4 Composition / dependency note

`file_rewind` is **only useful if snapshots exist**. That requires a checkpoint cadence
(`checkpoint-policy` mode ≠ `"off"`) wired on the surface. The tool surfaces a clear typed
`uninitialized` (no shadow store) / `(no snapshots)` message when the cadence isn't running, so the
failure mode is legible rather than silent. Wiring the cadence is a **separate** existing knob, not
N5's job.

---

## 6. 테스트 계획 (hellgate + e2e)

New battery `tests/unit/file-history-rewind-hellgate.test.ts`, driving the port with a fake
`GitRunner` + tmpdir baseDir (same harness as `shadow-odb-hellgate.test.ts`):

| Case | Asserts |
|---|---|
| H1 snapshot + restore one file | Edit F across 3 snapshots; `file_rewind {path:F, to:ref1}` restores F's v1 content; **siblings untouched** (byte-compare). |
| H2 restore non-existent path | `file_rewind {path:"does/not/exist"}` → typed `rewind-failed` / empty `file_history`, NO FS mutation, NO safety-net ref. |
| H3 multiple versions ordering | `file_history {path:F}` returns versions **newest-first**, timestamps monotonic, blobSha distinct per content change, identical content de-dups. |
| H4 default = second-newest | `file_rewind {path:F}` (no `to`) restores the version BEFORE the latest edit ("undo last edit"). |
| H5 deleted-file semantics | File deleted since snapshot → restored (re-created) when target predates deletion; `onAbsent:"delete"` removes a file that didn't exist at the target ref; `onAbsent:"error"` (default) → typed error. |
| H6 ref-injection defense | `to:"refs/heads/main"` / `to:"../../etc"` / arbitrary sha NOT in `listSnapshots` → rejected BEFORE any git call (allow-list validation). |
| H7 safety-net ref taken | A pre-rewind ref is created before the write; visible via `shadow_snapshots`; recoverable. |
| H8 path-safety parity | absolute path / `..` segment → typed `rewind-failed` before FS/git (mirrors `restorePartial`). |
| H9 uninitialized / no-snapshots | shadow store absent → `uninitialized`; store present but path never snapshotted → legible empty history. |
| H10 abort pre-flight | `ctx.signal.aborted` before start → `ok:false "aborted before start"`, no mutation. |
| H11 exactOptionalPropertyTypes | absent `to` / `onAbsent` stay ABSENT in the opts bag (`"onAbsent" in opts === false`). |
| H12 stale-read coordination | After `file_rewind`, the read-state mtime for F is invalidated so a subsequent edit isn't wrongly blocked/allowed (see §8). |

**e2e / smoke:** a `tests/smoke/` scenario — agent edits a file twice, then `file_rewind` to v1, and
the verify gate observes the restored content (replay-deterministic; fake LLM tool-call script).

Drift/manifest: extend `tool-surface-manifest-hellgate.test.ts` (the file already in the working
tree) with the `file_rewind`/`file_history` row; extend `feature-catalog-*` fixtures.

---

## 7. 단계 (Phases)

- **L1 — port primitive (closed).** `fileHistory` + `restoreFileAtRef` + `FileVersion` /
  `RestoreFileOptions` / `RestoreFileResult` on `ShadowOdb`, default impl via `git ls-tree` +
  `git cat-file` + `git checkout <ref> -- <path>` routed at `--git-dir=<shadow>`. Ref allow-list
  validation. H1–H9 hellgate. **No tool yet** — pure storage extension, default callers unaffected.
- **L2 — tool surface.** `src/tool/file-history/{file-rewind,file-history,index}.ts`, plane-clean,
  typed-error mapping. H10–H11. Register behind `QUANTA_FILE_HISTORY_REWIND` config-slot.
- **L3 — SSOT + catalog + CLI.** Manifest row + drift guard; `/file-rewind` CLI command (mirrors
  `snapshot-cmd.ts` / the rewind skill); fc leaf. H12 (stale-read coordination) + smoke.
- **L4 — (optional, deferred) skill wiring.** Fold `file_history`/`file_rewind` into the existing
  `rewind` system skill's decision tree (`src/skill/system-skills/rewind/SKILL.md`) so `/rewind`
  can route "undo just this one file" alongside the whole-tree `shadow_rewind`.

Each phase is independently shippable and default-OFF; L1 lands with zero behavioural change.

---

## 8. 리스크 / 대안 (Risks & Alternatives)

### 8.1 Storage growth
**N5 adds NONE.** It reads older commits the shadow-ODB already writes. The growth driver is the
checkpoint *cadence* (existing `checkpoint-policy`), already bounded by `QUANTA_SHADOW_ODB_MAX_BYTES`
(1 GiB default) + the LRU sweep. Risk: if a user runs N5 expecting deep history but cadence is
`"off"` or LRU evicted old commits, history is shallow/empty — mitigated by the legible
`(no snapshots)` message (§5.4) rather than a silent wrong-answer.

### 8.2 Reuse-vs-new tradeoff
We chose **new thin layer over reuse-only** because reuse-only is *impossible*: no existing port
restores a file at an arbitrary version (§3.2). We chose **reuse-storage over new-backup-store**
(rejecting Claude's parallel `trackedFileBackups` directory) to avoid double storage + a
two-sources-of-truth coherence bug. The residual risk: we depend on shadow-ODB's whole-tree commit
model — if a file is added to `.gitignore`/excludes inside the shadow store it won't be snapshotted
and thus won't have history. Acceptable: that's the same set of files `restorePartial` already
covers, so N5 inherits a well-understood boundary.

### 8.3 Interaction with stale-read-guard (ADR-0474)
`restoreFileAtRef` changes a file's content **out-of-band** from the read/edit tools. The
stale-read-guard's `ReadFileState` (`src/tool/stale-read-guard/state.ts`) holds the mtime the agent
last READ. After a rewind, that mtime is stale → a later edit could be wrongly blocked (guard thinks
the agent hasn't seen the new content) OR wrongly allowed. **Mitigation (H12):** after a successful
`file_rewind`, invalidate (drop) the restored path from `ReadFileState` so the next edit must
re-read — the safe, conservative coupling. This is a *coordination* requirement, not a conflict,
because stale-read-guard is freshness-only and holds no history.

### 8.4 Interaction with shadow auto-checkpoint
`restoreFileAtRef` takes a pre-rewind safety-net ref BEFORE writing (parity with `restorePartial`,
`types.ts:76-95`). If the auto-checkpoint policy is `per-mutating`/`pre-destructive`, the rewind tool
call itself may ALSO be anchored by the policy — producing two refs around one rewind. Harmless
(both are recovery points) but documented so the snapshot list isn't surprising. The policy's
fail-open posture (`checkpoint-policy.ts:90-96`) means a checkpoint failure never blocks the rewind.

### 8.5 Alternatives considered & rejected
- **(A) Extend `shadow_restore_partial` with a `ref` param.** Rejected: breaks its byte-stable
  signature (drift guards), conflates two mental models (§4.2).
- **(B) Wire ADR-0205 `restoreFiles(tag)` to honor the tag's SHA + add a `paths` filter.** Tempting
  (the SHA is already resolved there) but it lives in `@/agent` and is *forbidden* from touching
  `src/storage/shadow-odb/*` (`three-way-restore.ts:111-112`) — the missing primitive MUST live on
  the storage port. N5's L1 is exactly the primitive that would *also* let ADR-0205 finally honor
  its tag SHA — a nice latent win, but out of N5's scope.
- **(C) Parallel per-file backup store (Claude-style).** Rejected: double storage + coherence bug
  (§8.2).
- **(D) Lean on `git checkout <sha> -- <file>` against the USER repo.** Rejected: pollutes user
  index/reflog, requires the file to be committed, hits HARD_DENY destructive guards — not the
  implicit per-edit undo N5 wants (§3.1 git row).

---

## 9. 코드 위치 요약 (Code-location summary)

**Read during this audit (evidence):**
- `src/storage/shadow-odb/types.ts` — `ShadowOdb` port; `restorePartial` is last-ref-only (:111-139);
  hard-coded ref consts (:216-235); `listSnapshots` / `SnapshotMetadata` (:98-101, :249-258).
- `src/storage/shadow-odb/default.ts` — git-dir/work-tree routing; per-workspace lock.
- `src/tool/shadow/{rewind,restore-partial,snapshots}.ts` — existing tool envelopes (the templates).
- `src/agent/checkpoint-policy.ts` — auto-snapshot cadence (4-arm mode, fail-open, LRU sweep).
- `src/agent/per-tool-checkpoint/{port.ts,three-way-restore.ts}` — `restoreFiles(tag)` resolves a
  tag SHA but restores via `rewindToLast` (`three-way-restore.ts:106-112`) — confirms the gap.
- `src/tool/stale-read-guard/{state.ts,gate.ts}` — freshness-only; env-knob precedent (ADR-0474).
- `src/session/store.ts:528` — `rewindToMessage` (conversation axis, not files).
- `src/tool/git/*` — VCS but not session-implicit.
- `src/tool/surface/manifest.ts` — SSOT GATED-row shape to mirror.

**To be created / extended by the implementation (NOT this RFC):**
- `src/storage/shadow-odb/types.ts` + `default.ts` — ADD `fileHistory` + `restoreFileAtRef` (+ types).
- `src/tool/file-history/{file-rewind,file-history,index}.ts` — NEW tool pair.
- `src/tool/surface/manifest.ts` — NEW GATED row (`file_rewind` + `file_history`).
- `src/apps/cli/file-rewind-cmd.ts` — NEW `/file-rewind` CLI (mirror `snapshot-cmd.ts`).
- `tests/unit/file-history-rewind-hellgate.test.ts` — NEW battery (H1–H12).
- `tests/smoke/…` — NEW per-file-undo scenario.
- `docs/10.feature-catalog.md` (+ fc YAML) — NEW recovery/undo leaf.
- `docs/decisions/0477-file-history-rewind.md` — ADR for the landed slice.

---

### Appendix — one-line overlap verdict (for the index)

> N5 is a **genuine new per-file-history layer** — shadow-ODB's `restorePartial` restores named
> files but ONLY from the single last snapshot (`SHADOW_LAST_REF`), and ADR-0205 `restoreFiles(tag)`
> throws away the tag's SHA and restores `rewindToLast`; **no path restores a NAMED FILE to an
> ARBITRARY PRIOR VERSION**. Design: add ONE storage primitive (`restoreFileAtRef`) + a per-file
> history index over the EXISTING shadow commit graph (reuse the bytes, invent no new store) + a
> thin `file_rewind`/`file_history` tool pair. Default-OFF.
