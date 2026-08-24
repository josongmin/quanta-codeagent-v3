/**
 * Shared mutation-safety owner for V4A patch tools.
 *
 * Both `apply_patch` and `apply_patch_structured` parse the same Patch AST and
 * mutate through the same jailed adapter. Security and freshness policy must
 * therefore be identical at the tool boundary even though their apply
 * semantics differ (whole-patch atomic vs per-file isolated).
 */

import type { Patch, PatchFileSystemPort } from "@/patch/types"
import { sha256Hex } from "@/storage"
import { recordFreshBaseline } from "./_shared/fresh-hash"
import { guardWrite, type ReadFileState } from "./stale-read-guard"
import type { EditToolContext, GitWriteGuard, ToolEvent } from "./types"

/** Patch port required by model-facing mutators.
 *
 * The pure `@/patch` appliers only need filesystem CRUD. Tool-layer safety also
 * needs a jailed stat so stale-read checks and post-commit baseline refresh use
 * the same canonical absolute path as `read`. Requiring this capability at the
 * factory boundary prevents a production patch tool from being constructed
 * with a port that silently cannot enforce freshness.
 *
 * ADR-0548 additionally uses the port's INHERITED `readFile` to obtain a
 * target's current whole-file digest, so the preflight decides on CONTENT the
 * same way `edit` does. No extra method is needed: content was always reachable
 * through `PatchFileSystemPort`; only the freshness rule changed.
 */
export interface GuardedPatchFileSystemPort extends PatchFileSystemPort {
  statTarget(path: string): Promise<
    | { readonly exists: true; readonly resolvedPath: string; readonly mtimeMs: number }
    | {
        readonly exists: false
      }
  >
}

/** Hard-deny the first protected source or move destination before mutation. */
export const guardPatchTargets = (
  patch: Patch,
  guard: GitWriteGuard | undefined,
  toolName: "apply_patch" | "apply_patch_structured",
): ToolEvent | null => {
  if (guard === undefined) return null
  for (const op of patch.ops) {
    const targets =
      op.kind === "update" && op.moveTo !== undefined ? [op.path, op.moveTo] : [op.path]
    for (const target of targets) {
      const reason = guard(target)
      if (reason !== null) {
        return {
          type: "result",
          result: {
            ok: false,
            output: `git-escape-vector denial: cannot ${toolName} to ${target} (${reason}); use a different path`,
            failure: { mode: "permission_denied", path: target },
          },
        }
      }
    }
  }
  return null
}

/** The model-facing deny used whenever the freshness check itself could not RUN
 *  (as opposed to running and finding drift). A failed `statTarget` and a failed
 *  content read are the same class of outcome — we cannot prove the target is
 *  what the model last saw — so they share ONE verdict and ONE wording rather
 *  than letting a second fail-soft branch drift into a different (or absent)
 *  answer. Fail-CLOSED: deny before mutation, and stay inside the model-facing
 *  no-throw ToolResult boundary. */
const staleCheckFailed = (
  toolName: "apply_patch" | "apply_patch_structured",
  path: string,
): ToolEvent => ({
  type: "result",
  result: {
    ok: false,
    output: `${toolName}: cannot safely verify freshness of ${path}; re-read the target and retry`,
    failure: { mode: "rejected", reason: "stale_read_check_failed" },
  },
})

/**
 * ADR-0548 — the target's CURRENT whole-file digest for the content-authority
 * comparison, or `undefined` when no digest can decide the verdict (nothing was
 * recorded for this path, so `checkFresh` falls back to the forward-mtime rule
 * byte-for-byte).
 *
 * COST: exactly one extra `readFile` per target that HAS a recorded digest, and
 * ZERO reads otherwise — an UNREAD target (the create case) and a ranged-read
 * target (mtime baseline, no whole-file digest) both short-circuit before any
 * IO. Measured over this repo's `src/tool` corpus (316 files, p50 5.1 kB, p90
 * 16 kB, max 65 kB): ~27 µs per target warm (≈20 µs read + ≈4 µs sha256), i.e.
 * +0.27 ms on a 10-file patch and +1.35 ms on a 50-file patch — three to four
 * orders of magnitude under the LLM turn that produced the patch. The applier's
 * own plan phase re-reads every Update target microseconds later, so this read
 * lands warm by construction rather than paying a cold seek.
 *
 * `resolvedPath` (not the raw op path) is hashed so the bytes measured belong to
 * the SAME canonical path `statTarget` reported and `guardWrite` keys on.
 */
const currentTargetDigest = async (
  port: GuardedPatchFileSystemPort,
  state: ReadFileState,
  resolvedPath: string,
): Promise<{ readonly ok: true; readonly digest?: string } | { readonly ok: false }> => {
  if (state.recordedContent(resolvedPath) === undefined) return { ok: true }
  try {
    return { ok: true, digest: sha256Hex(await port.readFile(resolvedPath)) }
  } catch {
    // A failed read is not evidence the target is unchanged. Same fail-closed
    // shape the `statTarget` failure already uses — never a new crash path.
    return { ok: false }
  }
}

/** Hard-deny an update/delete target that drifted since its last model read.
 *
 *  ALL-TARGET PREFLIGHT-THEN-WRITE: every target is checked here, before the
 *  applier writes anything, so a deny is never a partial write. */
export const guardStalePatchTargets = async (
  patch: Patch,
  port: GuardedPatchFileSystemPort,
  ctx: Pick<EditToolContext, "readFileState"> | undefined,
  toolName: "apply_patch" | "apply_patch_structured",
): Promise<ToolEvent | null> => {
  const state = ctx?.readFileState
  if (state === undefined) return null
  for (const op of patch.ops) {
    if (op.kind !== "update" && op.kind !== "delete") continue
    let stat: Awaited<ReturnType<GuardedPatchFileSystemPort["statTarget"]>>
    try {
      stat = await port.statTarget(op.path)
    } catch {
      // A failed stat is not evidence that the target is absent. Deny before
      // mutation and preserve the model-facing no-throw ToolResult boundary.
      return staleCheckFailed(toolName, op.path)
    }
    if (!stat.exists) continue
    // ADR-0548 — CONTENT is the authority; the mtime is a hint. Without the
    // digest a content swap that preserves (or rewinds) the timestamp — `cp -p`,
    // `rsync --times`, `tar -x`, two writes in one second-granularity tick — was
    // refused on an `edit` target and ALLOWED here, so the verdict depended on
    // which tool the model happened to pick.
    const digest = await currentTargetDigest(port, state, stat.resolvedPath)
    if (!digest.ok) return staleCheckFailed(toolName, op.path)
    const guard = guardWrite(state, stat.resolvedPath, stat.mtimeMs, digest.digest)
    if (!guard.ok) {
      return {
        type: "result",
        result: {
          ok: false,
          output: guard.error.message,
          failure: { mode: "rejected", reason: "stale_read" },
        },
      }
    }
  }
  return null
}

/**
 * ADR-0548 — a successful mutation IS a fresh observation of its own output, for
 * the CONTENT digest exactly as for the mtime. Without this the NEXT patch to
 * the same file compares the post-commit bytes against the PRE-commit digest and
 * is vetoed `stale_read` by the agent's own write — the self-inflicted staleness
 * the jul-13 edit-fresh-hash work already had to cure for the mtime rule.
 *
 * Refreshes ONLY a digest that already exists: a path the agent never fully read
 * must stay on the mtime rule (and must not pay a read to learn that). Post-
 * commit best-effort — the caller swallows, since the mutation is already
 * committed and a stat/read failure must never rewrite its verdict.
 */
const refreshContentBaseline = async (
  port: GuardedPatchFileSystemPort,
  state: ReadFileState,
  resolvedPath: string,
): Promise<void> => {
  if (state.recordedContent(resolvedPath) === undefined) return
  state.recordContent(resolvedPath, sha256Hex(await port.readFile(resolvedPath)))
}

/** Refresh stale-read baselines for successfully committed, still-existing files. */
export const refreshPatchBaselines = async (
  port: GuardedPatchFileSystemPort,
  ctx: Pick<EditToolContext, "editFreshHash" | "readFileState">,
  paths: readonly string[],
): Promise<void> => {
  const state = ctx.readFileState
  if (ctx.editFreshHash !== true || state === undefined) return
  for (const path of paths) {
    try {
      const stat = await port.statTarget(path)
      if (!stat.exists) continue
      recordFreshBaseline(ctx, stat.resolvedPath, stat.mtimeMs)
      await refreshContentBaseline(port, state, stat.resolvedPath)
    } catch {
      // Best-effort after commit: a stat failure must not rewrite the mutation verdict.
    }
  }
}
