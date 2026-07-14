/**
 * Closed-port + types for Phase 1 SUBAGENT PERSISTENCE (ADR-0158).
 *
 * ADR-0153 shipped serialize()/hydrate() helpers on the in-memory scheduler;
 * THIS module is the **hexagonal port** an external store satisfies so a
 * scheduler instance can survive across process restarts and detect handles
 * whose host process died mid-run (new {@link PersistedSubagentStatus}
 * `"interrupted"` arm).
 *
 * Plane-clean: this slice imports ONLY `../subagent-background` (the existing
 * in-memory scheduler we wrap). The jsonl adapter additionally pulls
 * `node:fs/promises` / `node:path` / `node:os` / `node:crypto`. No
 * `@/agent/loop`, `@/agent/dispatch`, `@/llm`, `@/permission`, `@/tool`.
 *
 * Phase 1 scope: STATE PERSISTENCE (list/poll/await across restart, plus the
 * `"interrupted"` arm). Phase 2 — actually re-spawning the interrupted task
 * (re-binding a {@link SubagentRunner} to the persisted spec and replaying its
 * conversation seed) — is deferred.
 */

import type { SubagentStatus as BaseSubagentStatus, SubagentSpec } from "../subagent-background"

/** Extended status union. ADR-0130's scheduler has 4 arms (running, completed,
 *  failed, cancelled). Persistence adds **"interrupted"** for handles whose
 *  host process died mid-run — detected on hydration when the persisted
 *  `hostPid` is not alive AND the persisted status was still `"running"`.
 *  Phase 2 (ADR-0159) upgrades interrupted → **"resumed"** when the orchestrator
 *  re-forks; `outputSummary = "resumed as <newId>"` lets list-readers chain
 *  forward mechanically (no prose parsing). */
export type PersistedSubagentStatus = BaseSubagentStatus | "interrupted" | "resumed"

/** What we write to disk for one handle. Mirrors the in-memory snapshot shape
 *  plus serializable persistence-only fields (`hostPid`, `workspace`). With
 *  `exactOptionalPropertyTypes` strict, optional fields are OMITTED when
 *  absent — never set to `undefined`. */
export interface PersistedHandle {
  /** Opaque handle id from the in-memory scheduler (`bg-<16hex>`). */
  readonly id: string
  /** Caller's task spec — preserved verbatim so the resume-by-task-replay
   *  follow-up in Phase 2 has the full input to re-fork from. */
  readonly spec: SubagentSpec
  /** Lifecycle arm (5-arm union — base 4 + `"interrupted"`). */
  readonly status: PersistedSubagentStatus
  /** Epoch ms when `fork()` was first called. */
  readonly startedAt: number
  /** Epoch ms when the run reached a terminal state. ABSENT while running. */
  readonly endedAt?: number
  /** Number of model turns the child consumed (0 when unknown). */
  readonly turns: number
  /** Short one-liner suitable for status-bar surfaces. */
  readonly outputSummary: string
  /** Full transcript or final answer; ABSENT for `running` / `interrupted`. */
  readonly outputDetail?: string
  /** Set on `status === "failed"` or `"interrupted"`. */
  readonly errorMessage?: string
  /** Host PID at fork time — used by hydration to detect a "running but
   *  process dead" handle. ABSENT when caller did not provide one (the
   *  hydrator then conservatively classifies as `"interrupted"`). */
  readonly hostPid?: number
  /** Workspace fingerprint at fork time. Helps cross-workspace audit + lets
   *  `list(workspace)` filter by source. ABSENT when caller did not provide. */
  readonly workspace?: string
  /** OPTIONAL conversation-snapshot id (ADR-0166 Phase 2.5 — conversation-seed
   *  replay). When set, identifies a {@link ConversationCheckpointStore}
   *  (ADR-0124) entry recorded just before the host died. The resume
   *  orchestrator's `buildReplaySpec` consults it to inject `seedMessages` into
   *  the re-forked spec. ABSENT ⇒ byte-identical to ADR-0159 Phase 2 (fresh
   *  fork from `spec.task` only). Caller writes it at fork time / turn
   *  boundary; persistence layer just preserves the string. */
  readonly conversationSnapshotId?: string
  /** OPTIONAL lineage depth (INV-09/INV-10 — jul-14 resume-depth-preservation).
   *  The REAL depth the background child RAN at, mirroring the runner's
   *  `AgentConfig.depth` convention (0 = root; `childDepthOf(parent) =
   *  parent.depth + 1`). Persisted at fork time so a later resume can enforce
   *  that the re-forked child does NOT gain spawn authority by being re-derived
   *  to a shallower depth (the runner's depth AUTHORITY is
   *  `childDepthOf(resume-time-parent)`, which ignores the persisted lineage —
   *  see `subagent-runner.ts:654`). ABSENT for legacy records written before
   *  this field existed; the resume orchestrator treats an absent depth as
   *  fail-closed under a `lineageGuard` (INV-10 — never silently resume at the
   *  re-derived / possibly-root depth). Under the shipping default (cap=1) a
   *  background child is always depth-1 so this field is INERT; it only bites
   *  under cap>=2. Non-negative integer; NaN/negative/fractional values are
   *  treated as absent by the codec (fail-closed). */
  readonly depth?: number
}

/** Closed port: an external store satisfies this so the hydrating wrapper can
 *  read/write handle snapshots durably. The jsonl-on-disk adapter is one
 *  implementation; tests use an in-memory fake. */
export interface PersistentSchedulerStore {
  /** Append-only save. Each call appends a new line to the per-handle file
   *  (JSONL semantics — NEVER truncate). The latest line is the current
   *  state. Surface: throws {@link PersistenceError} `"io-failed"` on
   *  underlying filesystem failure (disk full / EPERM); never silently
   *  drops a write. */
  save(handle: PersistedHandle): Promise<void>
  /** Load latest state for `id`, or `null` when unknown. Missing file is
   *  `null`, NOT an error. Parse failure on the last non-empty line throws
   *  {@link PersistenceError} `"parse-failed"`. */
  load(id: string): Promise<PersistedHandle | null>
  /** Enumerate all persisted handles for the workspace, sorted by
   *  `startedAt` DESC (newest first). A corrupt per-handle file does NOT
   *  abort the list — it is silently skipped (rationale: a single garbage
   *  file should not poison the entire workspace's handle history). */
  list(workspace: string): Promise<readonly PersistedHandle[]>
  /** Drop the handle's entire history. Idempotent — unknown id is a no-op. */
  delete(id: string): Promise<void>
  /** Prune handles older than `maxAgeMs` in terminal states (= status !==
   *  "running"). Running handles are NEVER pruned regardless of age. Returns
   *  count deleted. */
  prune(workspace: string, maxAgeMs: number): Promise<number>
}

/** Typed error class — exposes a closed `code` union the caller can branch
 *  on deterministically (no prose parsing).
 *
 *  - `"io-failed"`: underlying filesystem write/read/mkdir failure.
 *  - `"parse-failed"`: JSON.parse on the latest line of a per-handle file
 *    threw or returned a shape that does not match {@link PersistedHandle}.
 *  - `"missing"`: a load surfaced an explicit "unknown id" condition in a
 *    context where `null` was not the right return (reserved for future use;
 *    Phase 1 returns `null` on load-unknown). */
export class PersistenceError extends Error {
  constructor(
    public readonly code: "io-failed" | "parse-failed" | "missing",
    message: string,
  ) {
    super(message)
    this.name = "PersistenceError"
  }
}
