/**
 * Shared mutation-safety owner for V4A patch tools.
 *
 * Both `apply_patch` and `apply_patch_structured` parse the same Patch AST and
 * mutate through the same jailed adapter. Security and freshness policy must
 * therefore be identical at the tool boundary even though their apply
 * semantics differ (whole-patch atomic vs per-file isolated).
 */

import type { Patch, PatchFileSystemPort } from "@/patch/types"
import { recordFreshBaseline } from "./_shared/fresh-hash"
import { guardWrite } from "./stale-read-guard"
import type { EditToolContext, GitWriteGuard, ToolEvent } from "./types"

/** Patch port required by model-facing mutators.
 *
 * The pure `@/patch` appliers only need filesystem CRUD. Tool-layer safety also
 * needs a jailed stat so stale-read checks and post-commit baseline refresh use
 * the same canonical absolute path as `read`. Requiring this capability at the
 * factory boundary prevents a production patch tool from being constructed
 * with a port that silently cannot enforce freshness.
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

/** Hard-deny an update/delete target that drifted since its last model read. */
export const guardStalePatchTargets = async (
  patch: Patch,
  port: GuardedPatchFileSystemPort,
  ctx: Pick<EditToolContext, "readFileState"> | undefined,
): Promise<ToolEvent | null> => {
  const state = ctx?.readFileState
  if (state === undefined) return null
  for (const op of patch.ops) {
    if (op.kind !== "update" && op.kind !== "delete") continue
    const stat = await port.statTarget(op.path)
    if (!stat.exists) continue
    const guard = guardWrite(state, stat.resolvedPath, stat.mtimeMs)
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

/** Refresh stale-read baselines for successfully committed, still-existing files. */
export const refreshPatchBaselines = async (
  port: GuardedPatchFileSystemPort,
  ctx: Pick<EditToolContext, "editFreshHash" | "readFileState">,
  paths: readonly string[],
): Promise<void> => {
  if (ctx.editFreshHash !== true || ctx.readFileState === undefined) return
  for (const path of paths) {
    try {
      const stat = await port.statTarget(path)
      if (stat.exists) recordFreshBaseline(ctx, stat.resolvedPath, stat.mtimeMs)
    } catch {
      // Best-effort after commit: a stat failure must not rewrite the mutation verdict.
    }
  }
}
