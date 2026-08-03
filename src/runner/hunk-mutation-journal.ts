/**
 * `@/runner/hunk-mutation-journal` — RFC06-4 (B5): durable **mutation receipt**
 * + **CAS undo journal** for per-hunk partial apply.
 *
 * This module is a RECEIPT/CAS WRAPPER around the single hunk-mutation owner
 * `@/runner/hunk-apply#applyHunkSelection` (README single-owner matrix: "hunk
 * mutation = applyHunkSelection; allowed change = receipt/CAS wrapper ONLY").
 * It does NOT reimplement hunk math, does NOT introduce a second apply engine,
 * and does NOT write file bytes by any path other than the existing engine.
 *
 * Mutation Receipt primitive (aug-02 README §SOTA++):
 *   intent → effect → terminal receipt, with before/after/expected-current
 *   HASHES. `expectedCurrent` is the hash of the bytes the apply actually left
 *   on disk. Undo verifies disk `=== expectedCurrent` (CAS) BEFORE reverting —
 *   the current file is NEVER treated as a new baseline (no naive revert), and
 *   no success is recorded before the effect happens (no success-before-effect).
 *
 * Durability: the receipt is persisted through the EXISTING atomic writer
 * (`@/storage#writeFileAtomic`) as one JSON file per operation. No new ODB, no
 * new atomic writer, no second hash function (`sha256Hex` is the repo-wide
 * content-hash convention).
 */

import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { errMessage } from "@/shared"
import { sha256Hex, writeFileAtomic } from "@/storage"
import { splitHunks } from "./diff-ops"
import { applyHunkSelection } from "./hunk-apply"

/** A persisted mutation receipt. `state` is the terminal disposition; the
 *  hashes bind the receipt to exact byte snapshots so undo is content-verified,
 *  not path-verified. */
export interface HunkMutationReceipt {
  readonly operationId: string
  /** Absolute (or cwd-relative) path the mutation targeted. */
  readonly path: string
  /** Full pre-apply content (the staleness baseline the diff was computed on).
   *  Stored verbatim so undo can restore it through the same engine. */
  readonly originalBefore: string
  readonly originalBeforeHash: string
  /** The whole-call proposed content (`after`) — hash only is load-bearing;
   *  the string is retained for diagnostics/reapply. */
  readonly proposedAfter: string
  readonly proposedAfterHash: string
  /** Hash of the bytes the apply actually left on disk (the CAS anchor undo
   *  verifies against). For a partial apply this is the reconstructed content,
   *  NOT `proposedAfter`. */
  readonly expectedCurrentHash: string
  /** The hunk ids that actually landed (diff-order, deduped by the engine). */
  readonly appliedHunks: readonly string[]
  readonly state: "applied" | "reverted"
  readonly createdAt: string
  readonly updatedAt: string
}

/** Durable store for mutation receipts. Kept minimal (put/load) so no second
 *  journal/ODB abstraction is introduced — the durable impl delegates bytes to
 *  the existing atomic writer. */
export interface HunkMutationJournalStore {
  put(receipt: HunkMutationReceipt): Promise<void>
  load(operationId: string): Promise<HunkMutationReceipt | null>
}

export interface HunkMutationJournalDeps {
  readonly store: HunkMutationJournalStore
  /** Injection seam for the disk read undo uses for its CAS check. Defaults to
   *  `node:fs/promises`. */
  readonly readFile?: (path: string) => Promise<string>
}

export interface ApplyWithReceiptRequest {
  readonly operationId: string
  readonly path: string
  readonly before: string
  readonly after: string
  readonly selectedHunkIds: readonly string[]
}

export type ApplyWithReceiptResult =
  | {
      readonly status: "applied"
      readonly receipt: HunkMutationReceipt
      /** The exact bytes the engine wrote (mirrors `applyHunkSelection`'s own
       *  `content`) so a caller projecting back onto the engine result shape
       *  does not have to fabricate it. */
      readonly content: string
    }
  | { readonly status: "stale"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string }

/**
 * Apply the accepted hunk subset via the EXISTING engine, then persist a
 * durable terminal receipt. The engine is called EXACTLY ONCE; the receipt is
 * written only AFTER the engine reports `applied` (no success-before-effect).
 * A `stale`/`error` engine result is passed through with NO `applied` receipt.
 */
export const applyHunkSelectionWithReceipt = async (
  req: ApplyWithReceiptRequest,
  deps: HunkMutationJournalDeps,
): Promise<ApplyWithReceiptResult> => {
  const res = await applyHunkSelection({
    path: req.path,
    before: req.before,
    after: req.after,
    selectedHunkIds: req.selectedHunkIds,
  })
  if (res.status !== "applied") return res
  const now = new Date().toISOString()
  const receipt: HunkMutationReceipt = {
    operationId: req.operationId,
    path: req.path,
    originalBefore: req.before,
    originalBeforeHash: sha256Hex(req.before),
    proposedAfter: req.after,
    proposedAfterHash: sha256Hex(req.after),
    // The bytes the engine LEFT on disk — hashed from the engine's own reported
    // content, not re-derived, so the receipt matches the actual effect.
    expectedCurrentHash: sha256Hex(res.content),
    appliedHunks: res.appliedHunkIds,
    state: "applied",
    createdAt: now,
    updatedAt: now,
  }
  await deps.store.put(receipt)
  return { status: "applied", receipt, content: res.content }
}

export type UndoResult =
  | { readonly status: "reverted"; readonly receipt: HunkMutationReceipt }
  | { readonly status: "stale"; readonly reason: string }
  | { readonly status: "not-found"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string }

/**
 * Revert a previously-applied mutation via the SAME engine, gated on a CAS
 * check: the current disk bytes must hash-equal the receipt's
 * `expectedCurrentHash`. On drift ⇒ `stale`, ZERO write (the current file is
 * NOT a new baseline). On match ⇒ the inverse target is `originalBefore`, and
 * the revert is applied through `applyHunkSelection` with the CURRENT content
 * as `before` and the original as `after` (whole selection) — one engine, no
 * second revert path.
 */
export const undoHunkMutation = async (
  operationId: string,
  deps: HunkMutationJournalDeps,
): Promise<UndoResult> => {
  const receipt = await deps.store.load(operationId)
  if (receipt === null) {
    return { status: "not-found", reason: `no mutation receipt for '${operationId}'` }
  }
  if (receipt.state === "reverted") {
    // Already undone — the current file is `originalBefore`, not `expectedCurrent`.
    // Fail-closed: never double-revert.
    return { status: "stale", reason: "mutation already reverted" }
  }
  const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"))
  let current: string
  try {
    current = await read(receipt.path)
  } catch {
    return { status: "stale", reason: "target file unreadable since apply" }
  }
  // ── CAS gate (content, not path) ─────────────────────────────────────────
  if (sha256Hex(current) !== receipt.expectedCurrentHash) {
    return { status: "stale", reason: "file changed since apply (CAS drift) — undo refused" }
  }
  // Inverse via the SAME engine: current → originalBefore. The engine's own
  // staleness gate re-verifies `current` is still on disk before writing.
  const res = await applyHunkSelection({
    path: receipt.path,
    before: current,
    after: receipt.originalBefore,
    // Whole-selection inverse: every hunk of (current → originalBefore).
    selectedHunkIds: hunkIdsOf(current, receipt.originalBefore),
  })
  if (res.status === "stale") {
    return { status: "stale", reason: `undo lost the CAS race: ${res.reason}` }
  }
  if (res.status === "error") return { status: "error", reason: res.reason }
  const reverted: HunkMutationReceipt = {
    ...receipt,
    state: "reverted",
    updatedAt: new Date().toISOString(),
  }
  await deps.store.put(reverted)
  return { status: "reverted", receipt: reverted }
}

/** All hunk ids of `before → after`, in diff order. Reuses the engine's own
 *  `splitHunks` (the SAME pure decomposition `applyHunkSelection` honours), so
 *  the id set is identical to what the engine will apply. */
const hunkIdsOf = (before: string, after: string): string[] =>
  splitHunks(before, after).map((h) => h.id)

// ── In-memory store (tests / ephemeral) ──────────────────────────────────────

/** Non-durable store for unit tests and gate-OFF ephemeral use. */
export const makeInMemoryJournalStore = (): HunkMutationJournalStore => {
  const map = new Map<string, HunkMutationReceipt>()
  return {
    async put(receipt) {
      map.set(receipt.operationId, receipt)
    },
    async load(operationId) {
      return map.get(operationId) ?? null
    },
  }
}

// ── Durable store (reuses the existing atomic writer — NO new ODB) ────────────

/** Sanitize an operationId into a safe filename component (defense against a
 *  path-traversal id). NOT an authority heuristic — purely a filesystem-safety
 *  transform on an id the caller already owns. */
const safeFileName = (operationId: string): string =>
  `${operationId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`

/**
 * Durable store: one atomic JSON file per operation under `dir`. Bytes go
 * through `writeFileAtomic` (temp+fsync+rename) — the same durability barrier
 * the hunk engine itself uses. No new atomic writer, no ODB.
 */
export const makeDurableJournalStore = (dir: string): HunkMutationJournalStore => ({
  async put(receipt) {
    await mkdir(dir, { recursive: true })
    await writeFileAtomic(join(dir, safeFileName(receipt.operationId)), JSON.stringify(receipt))
  },
  async load(operationId) {
    try {
      const raw = await readFile(join(dir, safeFileName(operationId)), "utf8")
      return JSON.parse(raw) as HunkMutationReceipt
    } catch (e) {
      // Missing file ⇒ null (no receipt). A malformed file is an integrity fault
      // surfaced as null (fail-closed: undo then reports not-found, never guesses).
      void errMessage(e)
      return null
    }
  },
})
