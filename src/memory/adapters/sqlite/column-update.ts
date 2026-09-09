/**
 * Column-local SQL update for SqliteStore (SEP7-D-10).
 *
 * Patch keys not in the allowlist are ignored. `embedding` is touched only
 * when the key is present: `undefined`/absent-value clears the BLOB; a
 * vector serializes. Omitted embedding leaves the raw BLOB alone.
 */

import { assertValidMemoryPatch, MEMORY_PATCH_FIELDS, type MemoryPatchField } from "../../patch"
import type { MemoryPatch } from "../../types"
import { serializeVec } from "../../vector"

export const MEMORY_UPDATE_COLUMNS = MEMORY_PATCH_FIELDS
type UpdateColumn = MemoryPatchField

export interface SqlUpdate {
  readonly sql: string
  readonly params: Record<string, string | number | Uint8Array | null>
}

const sqlColumnName = (key: UpdateColumn): string => {
  if (key === "accessCount") return "access_count"
  if (key === "lastAccessedAt") return "last_accessed_at"
  if (key === "supersededBy") return "superseded_by"
  if (key === "sessionId") return "session_id"
  if (key === "taskGroup") return "task_group"
  if (key === "reuseRule") return "reuse_rule"
  if (key === "lastDecayedAt") return "last_decayed_at"
  return key
}

const bindScalar = (
  params: Record<string, string | number | Uint8Array | null>,
  column: string,
  value: unknown,
): void => {
  params[`$${column}`] = value === undefined || value === null ? null : (value as string | number)
}

const applyPatchKey = (
  key: UpdateColumn,
  patch: MemoryPatch,
  sets: string[],
  params: Record<string, string | number | Uint8Array | null>,
): void => {
  if (key === "embedding") {
    if (!Object.hasOwn(patch, "embedding")) return
    const vec = patch.embedding
    params.$embedding = vec === undefined ? null : serializeVec(vec)
    sets.push("embedding = $embedding")
    return
  }
  if (key === "tags") {
    params.$tags = JSON.stringify(patch.tags ?? [])
    sets.push("tags = $tags")
    return
  }
  if (key === "appliesTo") {
    params.$applies_to_cwd = patch.appliesTo?.cwd ?? null
    sets.push("applies_to_cwd = $applies_to_cwd")
    return
  }
  const column = sqlColumnName(key)
  bindScalar(params, column, patch[key])
  sets.push(`${column} = $${column}`)
}

export const buildMemoryColumnUpdate = (
  id: string,
  patch: MemoryPatch,
  updatedAt: number,
): SqlUpdate | null => {
  assertValidMemoryPatch(patch)
  const sets: string[] = ["updated_at = $updated_at"]
  const params: Record<string, string | number | Uint8Array | null> = {
    $id: id,
    $updated_at: updatedAt,
  }
  for (const key of MEMORY_UPDATE_COLUMNS) {
    if (!Object.hasOwn(patch, key)) continue
    applyPatchKey(key, patch, sets, params)
  }
  if (sets.length === 0) return null
  return {
    sql: `UPDATE memories SET ${sets.join(", ")} WHERE id = $id`,
    params,
  }
}
