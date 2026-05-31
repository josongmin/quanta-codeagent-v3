/**
 * ADR-0216 — Stage1Store port: agent-side persist seam for `stage1_outputs`.
 *
 * Why this slice exists:
 *   `@/memory/consolidate#Stage1Store` is the SQLite-bound class that owns
 *   the canonical `stage1_outputs` schema. The previous wire reached into
 *   it directly from `runAgent` via the consolidator block — but the host
 *   was free to forget to inject `store`, in which case the test-only
 *   `INSERT` path stayed dead in production.
 *
 *   This port abstracts the `(write, read, incrementUsageCount,
 *   selectForPhase2)` quartet so an agent-side composition root can default
 *   to `inMemoryStage1Store` (zero deps) and upgrade to the SQLite adapter
 *   when one is wired. No code path is silently "no-op when store missing".
 *
 * Slice-local: this port is `@/agent`-owned. The underlying SQLite class
 * stays in `@/memory/consolidate` (single owner of the schema). The
 * `sqliteStage1Store` adapter in the sibling file wraps that class so the
 * import goes UP from `@/agent` to `@/memory` — biome-allowed by RFC §3.1.
 *
 * NO-THROW: every method returns a Promise that resolves with a typed
 * result. Errors surface as `{ ok:false, ... }` so callers branch instead
 * of catch. (Constructor MAY throw — host bootstrap is the place to fail
 * loudly on a bad disk.)
 *
 * exactOptional: optional fields use omission (never `field: undefined`).
 */

import type { MemoryOutcome } from "@/memory"

/** Slim, agent-side view of a Stage1 record — mirrors `@/memory#Stage1Output`
 *  but uses the agent's `WriteInput`/`ReadResult` discriminated shapes so
 *  the port stays decoupled from the storage-layer class. */
export interface Stage1Record {
  readonly threadId: string
  readonly rolloutSlug: string
  readonly rolloutSummary: string
  readonly rawMemory: string
  readonly preferenceSignals: ReadonlyArray<string>
  /** ms since epoch — when the source session was last touched. */
  readonly generatedAt: number
  /** Cumulative usage count — phase2 picker increments on read. */
  readonly usageCount: number
  /** Phase2 promotion flag — set by picker after selection. */
  readonly selectedForPhase2: boolean
  /** ADR-0131 optional outcome enum + evidence. KEYS OMITTED when absent. */
  readonly outcome?: MemoryOutcome
  readonly outcomeEvidence?: string | null
}

/** Input for `write` — the agent's session-end hook supplies this. */
export interface WriteInput {
  readonly threadId: string
  readonly rolloutSlug: string
  readonly rolloutSummary: string
  readonly rawMemory: string
  readonly preferenceSignals: ReadonlyArray<string>
  readonly generatedAt: number
  /** Optional outcome enum (ADR-0131). KEY OMITTED when not declared. */
  readonly outcome?: MemoryOutcome
  readonly outcomeEvidence?: string | null
}

/** Closed result discriminated union — no throw. */
export type Stage1Result<T> = { readonly ok: true; readonly value: T } | Stage1ErrorResult

export type Stage1ErrorResult =
  | { readonly ok: false; readonly code: "not-found"; readonly message: string }
  | { readonly ok: false; readonly code: "io-failed"; readonly message: string }
  | { readonly ok: false; readonly code: "invalid-input"; readonly message: string }

/**
 * 5-verb store seam:
 *   - `write`                  — upsert by threadId (Phase 1 entry point).
 *   - `read`                   — fetch by threadId (Phase 2 picker reads here).
 *   - `incrementUsageCount`    — atomic +1 (picker bumps after using a row).
 *   - `selectForPhase2`        — batch promotion (caller passes candidates;
 *                                store records the selection so subsequent
 *                                phases see `selectedForPhase2 === true`).
 *   - `reuseConsumedEntry`     — ADR-0233 / audit C-1 owning-seam: ONE atomic
 *                                operation that "consumes" a single entry for
 *                                Phase-2 reuse — marks it selected AND accounts
 *                                exactly +1 usage. See its contract below.
 *
 * The selection contract:
 *   `selectForPhase2(threadIds)` marks each as selected AND increments
 *   `usageCount` atomically per row. Returns the records actually flipped
 *   (rows missing in the store are silently skipped — caller observes via
 *   length comparison).
 *
 * The reuse contract (audit C-1 — double-bump prevention):
 *   `reuseConsumedEntry(threadId)` is the SINGLE semantic operation a Phase-2
 *   reuse path must call. Composing `incrementUsageCount` + `selectForPhase2`
 *   by hand double-counts usage (both bump) and lets selection + accounting
 *   drift. This op flips `selectedForPhase2 = true` and accounts the read as
 *   EXACTLY +1 in one mutation, so the two surfaces can never disagree. A
 *   missing row ⇒ `not-found` (no silent create); empty id ⇒ `invalid-input`.
 */
export interface Stage1StorePortV2 {
  write(input: WriteInput): Promise<Stage1Result<Stage1Record>>
  read(threadId: string): Promise<Stage1Result<Stage1Record | null>>
  incrementUsageCount(threadId: string): Promise<Stage1Result<Stage1Record>>
  selectForPhase2(
    threadIds: ReadonlyArray<string>,
  ): Promise<Stage1Result<ReadonlyArray<Stage1Record>>>
  /** Atomically consume ONE entry for Phase-2 reuse: select + usage `+1`
   *  (never `+2`). The owning seam for the reuse path. */
  reuseConsumedEntry(threadId: string): Promise<Stage1Result<Stage1Record>>
}
