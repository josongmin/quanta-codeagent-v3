/**
 * ADR-0395 — Run Ledger: unified long-running-work state model.
 *
 * quanta models long-running work in three disjoint ways today:
 *   - shell-detached     — `{ shellId, status: "running" }` resumed via
 *                          `bash_await` / `bash_kill`
 *   - subagent background — `TaskStatus = running|completed|failed|stopped`
 *                          resumed via `task_output` / `task_stop`
 *   - MCP tasks          — a poller over task ids
 *
 * That fragmentation means no single surface can answer "what is in flight,
 * what is waiting on me, what just finished?". This module defines ONE state
 * model + closed port so a UI can render Running / Waiting / Completed across
 * ALL of them.
 *
 * THIS WAVE IS MODEL-ONLY. Nothing here imports from `@/agent` core, `@/apps`,
 * `@/subagent`, `@/tool`, or `@/mcp`. IDs are caller-supplied so the wave-2
 * adapters can correlate a ledger entry to its native `shellId` / `task_id` /
 * MCP task id WITHOUT this slice depending on those slices.
 */

/** Origin of a long-running work item. Closed enum — the four flavours quanta
 *  can spawn. `exec` covers detached one-shot processes that are neither an
 *  interactive shell session nor a subagent (e.g. a background build). */
export type RunKind = "shell" | "subagent" | "mcp_task" | "exec"

/** Lifecycle status of a run.
 *  - running   — actively progressing
 *  - waiting   — blocked, see {@link WaitingOn}
 *  - completed — finished successfully (terminal)
 *  - failed    — finished with an error (terminal)
 *  - stopped   — cancelled by user/host (terminal)
 *
 *  `running` and `waiting` are the two ACTIVE states (never LRU-evicted). The
 *  three terminal states are SETTLED states (subject to bounded retention). */
export type RunStatus = "running" | "waiting" | "completed" | "failed" | "stopped"

/** What a `waiting` run is blocked on — drives the UI's "needs you" badge. */
export type WaitingOn = "user" | "tool" | "network" | "child_agent"

/** A produced output a UI can offer to open/inspect. `ref` is either a path or
 *  an inline reference (e.g. `inline:<digest>`). */
export interface RunArtifact {
  readonly kind: "log" | "stdout" | "summary" | "file"
  readonly ref: string
}

/** A single unified long-running-work record.
 *
 *  `id` correlates to the native identifier of the underlying work
 *  (`shellId` / `task_id` / MCP task id) — supplied by the caller, never minted
 *  here, so the ledger never needs to know the source slice's id scheme.
 *
 *  All fields are readonly: the store returns frozen copies so a reader cannot
 *  mutate ledger state by holding a returned reference. */
export interface RunEntry {
  /** Correlates to shellId / task_id / mcp task id. Caller-supplied. */
  readonly id: string
  readonly kind: RunKind
  /** threadId or agent id that started the work. */
  readonly owner: string
  /** Human-readable label (command preview / prompt preview). */
  readonly title: string
  readonly status: RunStatus
  readonly startedAt: number
  readonly lastEventAt: number
  /** Present only while `status === "waiting"` (best-effort, may persist after). */
  readonly waitingOn?: WaitingOn
  /** Resume hint a UI can surface verbatim, e.g. `"bash_await <shellId>"`. */
  readonly resumeAction?: string
  readonly artifacts: readonly RunArtifact[]
  /** Failure message when `status === "failed"`. */
  readonly error?: string
}

/** Serializable, immutable view of the whole ledger for persistence / IPC. */
export interface RunLedgerSnapshot {
  readonly entries: readonly RunEntry[]
}

/**
 * Closed port over the run ledger. EVERY method is NO-THROW: malformed input,
 * an unknown id, or a misbehaving clock NEVER throw — they return
 * `null` / the existing entry / an empty array.
 *
 * Clock seam: the `now` injected via {@link createRunLedger} stamps
 * `startedAt` / `lastEventAt`. Tests supply a monotone counter for
 * determinism.
 *
 * Retention: SETTLED entries (completed/failed/stopped) are LRU-evicted by
 * oldest `lastEventAt` once their count exceeds `maxRetained` (default 256).
 * RUNNING and WAITING entries are NEVER evicted — they are the active set a UI
 * must always be able to render. This mirrors `TaskRegistry`'s policy.
 */
export interface RunLedgerPort {
  /** Register a new run as `running`. Sets `lastEventAt === startedAt`. A
   *  duplicate id overwrites (latest registration wins). */
  start(init: {
    id: string
    kind: RunKind
    owner: string
    title: string
    resumeAction?: string
  }): RunEntry

  /** Record activity on a run: bumps `lastEventAt` to `now()`, optionally
   *  applies a status transition, a `waitingOn`, and/or appends an artifact.
   *  No-op (returns the entry unchanged, lastEventAt NOT bumped) if the run is
   *  already settled. Unknown id ⇒ null. */
  touch(
    id: string,
    patch: { status?: RunStatus; waitingOn?: WaitingOn; artifact?: RunArtifact },
  ): RunEntry | null

  /** Move a run to a terminal state. Idempotent: settling an already-settled
   *  entry is a no-op that returns the entry unchanged. Unknown id ⇒ null. */
  settle(
    id: string,
    status: "completed" | "failed" | "stopped",
    opts?: { error?: string; artifact?: RunArtifact },
  ): RunEntry | null

  /** Lookup by id. Unknown id ⇒ null. */
  get(id: string): RunEntry | null

  /** All entries matching every supplied filter axis (logical AND). */
  list(filter?: { status?: RunStatus; kind?: RunKind; owner?: string }): readonly RunEntry[]

  /** Entries with `status === "running"`. */
  running(): readonly RunEntry[]

  /** Entries with `status === "waiting"`. */
  waiting(): readonly RunEntry[]

  /** Immutable snapshot of all entries. */
  toSnapshot(): RunLedgerSnapshot

  /** Replace all entries from a snapshot (not a merge). Malformed entries are
   *  skipped; a malformed snapshot is a no-op. */
  fromSnapshot(snap: RunLedgerSnapshot): void
}
