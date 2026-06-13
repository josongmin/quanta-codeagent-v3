/**
 * `@/runner/hunk-apply` — partial-apply executor for per-hunk diff accept/reject
 * (T05). Surface-agnostic: the CLI inline-confirm path and (future) web canvas
 * both reduce a previewed mutation to `(path, before, after)` and call this with
 * the operator-selected hunk ids.
 *
 * Why a single executor for all 3 write paths (storage / apply_patch /
 * scripted_replace): per-hunk acceptance is a property of the DIFF, not the tool
 * that produced it. Every previewable mutation has a `(before, after)` pair, so
 * partial application is uniformly "reconstruct the content keeping only the
 * accepted hunks, then write it" — identical math for write/edit/apply_patch/
 * scripted_replace. This is the [[jun-09-patch-slice-sota-hardening]] mirror
 * discipline made structural: ONE apply path, no per-tool divergence.
 *
 * Safety (load-bearing):
 *   - STALENESS (RESTING tree, [[jun-09-patch-slice-sota-hardening]] 🔴 "mid-run
 *     판정 금지"): the file is re-read at apply time and compared to the `before`
 *     the diff was computed against. Any drift ⇒ `stale`, ZERO write — the
 *     selection referenced a numbering that no longer matches disk.
 *   - ATOMIC + MODE PRESERVATION: the write goes through `writeFileAtomic`
 *     (temp+fsync+chmod-to-original+rename), so a 0o755 script keeps its
 *     permission bits across the partial apply (the jun-09 F4 regression class).
 *
 * Pure-core dependency: hunk math is `@/runner/diff-ops#applySelectedHunks`
 * (the same LCS this slice already owns). This module adds ONLY I/O + safety.
 */

import { readFile } from "node:fs/promises"
import { writeFileAtomic } from "@/storage/atomic-write"
import { applySelectedHunks, splitHunks } from "./diff-ops"

export interface HunkApplyRequest {
  /** Absolute (or cwd-relative) path to the file being partially mutated. */
  readonly path: string
  /** File content the diff was computed AGAINST (the staleness baseline). */
  readonly before: string
  /** Full intended content (whole-call result) the model proposed. */
  readonly after: string
  /** Hunk ids (`h1`, `h2`, …) the operator accepted. Empty ⇒ a no-op apply
   *  whose result equals `before` (still a clean write through the same gate). */
  readonly selectedHunkIds: readonly string[]
}

export type HunkApplyResult =
  | {
      readonly status: "applied"
      /** The accepted hunk ids that were actually present in the diff. */
      readonly appliedHunkIds: readonly string[]
      /** The exact bytes written to disk (partial reconstruction). */
      readonly content: string
    }
  | {
      readonly status: "stale"
      /** Categorical reason (no file content) — safe to surface to the model. */
      readonly reason: string
    }
  | {
      readonly status: "error"
      readonly reason: string
    }

export interface HunkApplyDeps {
  /** Injection seam for the staleness read. Defaults to `node:fs/promises`. */
  readonly readFile?: (path: string) => Promise<string>
  /** Injection seam for the atomic write. Defaults to `@/storage`. */
  readonly writeFile?: (path: string, content: string) => Promise<void>
}

/**
 * Apply only the accepted hunks of `before → after` to the file at `path`.
 * Re-validates the RESTING file against `before` (staleness gate) before any
 * write; on drift returns `stale` with zero disk mutation. On success the
 * partial content is written atomically with the original file mode preserved.
 *
 * NEVER throws for an I/O failure on the read side that is a genuine drift
 * signal — a missing file when `before` is non-empty is treated as `stale`
 * (the file the diff described is gone). A write failure surfaces as `error`
 * (the bytes are the contract; we do not pretend success).
 */
export const applyHunkSelection = async (
  req: HunkApplyRequest,
  deps: HunkApplyDeps = {},
): Promise<HunkApplyResult> => {
  const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"))
  const write = deps.writeFile ?? ((p: string, c: string) => writeFileAtomic(p, c))

  // ── Staleness gate (RESTING tree) ────────────────────────────────────────
  let current: string
  try {
    current = await read(req.path)
  } catch {
    // The file the diff was computed against is unreadable now. If `before` was
    // a real (non-empty) snapshot, that is drift ⇒ stale (never blind-write).
    // For a brand-new file (`before === ""`) an ENOENT is EXPECTED, so a missing
    // file is NOT drift — treat the baseline as the empty document.
    if (req.before !== "") {
      return { status: "stale", reason: "target file unreadable since preview" }
    }
    current = ""
  }
  if (current !== req.before) {
    return { status: "stale", reason: "file changed since preview (staleness guard)" }
  }

  // ── Pure partial reconstruction ──────────────────────────────────────────
  const content = applySelectedHunks(req.before, req.after, req.selectedHunkIds)
  // Report only the ids that actually correspond to a hunk in this diff, deduped
  // and in DIFF ORDER (drops unknown + duplicate ids the caller may have passed —
  // keeps the success report honest; the apply itself is already Set-based).
  const real = splitHunks(req.before, req.after).map((h) => h.id)
  const selected = new Set(req.selectedHunkIds)
  const appliedHunkIds = real.filter((id) => selected.has(id))

  // ── Atomic write (mode-preserving) ───────────────────────────────────────
  try {
    await write(req.path, content)
  } catch (e) {
    return { status: "error", reason: `write failed: ${(e as Error)?.message ?? String(e)}` }
  }
  return { status: "applied", appliedHunkIds, content }
}
