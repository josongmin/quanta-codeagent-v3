/**
 * ADR-0205 — `ThreeWayRestorePort` default implementation.
 *
 * Composes `ShadowOdb` (file leg) + `ConversationCheckpointStore` (task
 * leg) over a `GranularRegistry` (tag→SHA lookup) so the surface (CLI /
 * REPL / Tauri / JSON-RPC) can offer Cline's "Restore Files Only /
 * Restore Task Only / Restore Both" three commands with a SINGLE typed
 * result shape.
 *
 * # Orthogonality
 *
 * Each leg is independent:
 *
 *   - `restoreFiles(tag)` touches the workspace via `ShadowOdb`. The
 *     conversation store is NEVER consulted (the call does not even need
 *     `ports.conversationStore`).
 *   - `restoreTask(tag)`  reads from `ConversationCheckpointStore`. The
 *     shadow ODB is NEVER consulted.
 *   - `restoreBoth(tag)`  does files first, then conversation. If the
 *     files leg fails, the conversation leg is NOT attempted (the outcome
 *     reflects the files-leg failure).
 *
 * # Tag resolution
 *
 * The tag identifies an anchor in the granular registry (built by
 * `GranularCheckpointPolicy`). For the files leg we use the resolved SHA
 * through the ordinal-addressed ShadowOdb API). For the task leg we
 * use the tag VERBATIM as the `ConversationCheckpointStore` id — caller
 * is responsible for `record`-ing the conversation snapshot under the
 * SAME tag at anchor time. This decoupling means a caller may wire
 * EITHER store independently without breaking the other leg.
 *
 * # No-throw
 *
 * Every method collapses every failure (including programmer-bug input
 * like an unknown tag) into a typed `RestoreOutcome`. The only legal
 * throw is during construction.
 *
 * # exactOptionalPropertyTypes
 *
 * Every optional field on `RestoreOutcome` is built via a conditional
 * spread so `tsc` never sees `field: undefined`.
 */

import type { Message } from "@/llm"
import type { ShadowOdbErrorCode } from "@/storage/shadow-odb"
import { ShadowOdbError } from "@/storage/shadow-odb"
import type {
  CheckpointTag,
  RestoreErrorCode,
  RestoreOptions,
  RestoreOutcome,
  ThreeWayRestorePort,
  ThreeWayRestorePorts,
} from "./port"

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Build a typed failure outcome WITHOUT mutating optional-field defaults
 *  (exactOptionalPropertyTypes). */
const failOutcome = (
  tag: CheckpointTag,
  errorCode: RestoreErrorCode,
  message: string,
  originalCode?: ShadowOdbErrorCode,
): RestoreOutcome => ({
  ok: false,
  errorCode,
  message,
  tag,
  ...(originalCode !== undefined ? { originalCode } : {}),
})

/** Coerce an unknown rejection into a `ShadowOdbErrorCode`. Returns the
 *  raw `code` if it is a `ShadowOdbError`; otherwise `"rewind-failed"`
 *  (the generic shadow-side failure code from `ShadowOdb.types`). */
const extractShadowCode = (e: unknown): ShadowOdbErrorCode => {
  if (e instanceof ShadowOdbError) return e.code
  return "rewind-failed"
}

/** Resolve the tag against the registry. Returns the entry on hit, or a
 *  pre-built failure outcome on miss. */
const resolveTag = (
  ports: ThreeWayRestorePorts,
  tag: CheckpointTag,
): { kind: "ok"; sha: string } | { kind: "fail"; outcome: RestoreOutcome } => {
  const entry = ports.registry.lookup(tag)
  if (entry === null) {
    return {
      kind: "fail",
      outcome: failOutcome(tag, "tag-not-found", `granular registry has no entry for tag: ${tag}`),
    }
  }
  return { kind: "ok", sha: entry.sha }
}

/* ------------------------------------------------------------------ */
/* legs                                                                */
/* ------------------------------------------------------------------ */

/** FILES leg. Resolve the tag SHA to the current ordinal snapshot list, then
 * restore through ShadowOdb's ordinal API with `expectSha`. The second guard
 * closes the list→restore race: a concurrent anchor can shift the ordinal,
 * but can never retarget this destructive operation silently. */
const doFilesLeg = async (
  ports: ThreeWayRestorePorts,
  tag: CheckpointTag,
  opts: RestoreOptions | undefined,
): Promise<RestoreOutcome> => {
  // Resolve the tag FIRST — it is a cheap, hermetic check and gives the
  // caller the most-specific error. Misconfigured ports come SECOND.
  const resolved = resolveTag(ports, tag)
  if (resolved.kind === "fail") return resolved.outcome
  if (ports.shadowOdb === undefined) {
    return failOutcome(
      tag,
      "shadow-odb-not-configured",
      "files leg requires ports.shadowOdb to be wired",
    )
  }

  let ordinal: number
  try {
    const snapshots = await ports.shadowOdb.listSnapshots(ports.workspace)
    const index = snapshots.findIndex((snapshot) => snapshot.sha === resolved.sha)
    if (index === -1) {
      return failOutcome(
        tag,
        "shadow-rewind-failed",
        `shadow snapshot for tag ${tag} (${resolved.sha.slice(0, 12)}) is unavailable`,
      )
    }
    ordinal = index + 1
  } catch (e) {
    const code = extractShadowCode(e)
    return failOutcome(tag, "shadow-rewind-failed", `shadow snapshot lookup failed: ${code}`, code)
  }

  // Compute the list of changed files against the SELECTED snapshot before
  // the rewind. Best-effort: a diff failure does NOT block the restore (we
  // surface an empty list), but a moved ordinal is never used as evidence.
  let filesChanged: ReadonlyArray<string> = []
  try {
    const diff = await ports.shadowOdb.diffSinceRef(ports.workspace, ordinal)
    if (diff.snap.sha === resolved.sha) filesChanged = parseChangedPaths(diff.diff)
  } catch {
    // Swallow only the non-mutating preview failure. The restore itself is
    // still SHA-pinned below and will fail closed if the target moved.
  }

  try {
    const rewindOpts: { allowDirtyMerge?: boolean; untracked?: "preserve" | "discard" } = {
      // Preserve untracked files by default (mirrors ShadowOdb default).
      untracked: "preserve",
      ...(opts?.allowDirtyMerge === true ? { allowDirtyMerge: true } : {}),
    }
    await ports.shadowOdb.rewindToRef(ports.workspace, ordinal, {
      ...rewindOpts,
      expectSha: resolved.sha,
    })
  } catch (e) {
    const code = extractShadowCode(e)
    return failOutcome(tag, "shadow-rewind-failed", `shadow-odb rewind failed: ${code}`, code)
  }

  return {
    ok: true,
    message: `files restored from tag ${tag} (${filesChanged.length} path${filesChanged.length === 1 ? "" : "s"})`,
    tag,
    filesChanged,
  }
}

/** Extract paths from a unified diff's `diff --git a/<path> b/<path>`
 *  lines. Pure. Returns DEDUPLICATED, insertion-order list of paths.
 *  Empty when the diff is empty. */
const parseChangedPaths = (diff: string): ReadonlyArray<string> => {
  if (diff.length === 0) return []
  const seen = new Set<string>()
  const paths: string[] = []
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue
    // Format: `diff --git a/<path> b/<path>`
    // Split on " b/" to get the b-side path which is the canonical target.
    const idx = line.indexOf(" b/")
    if (idx === -1) continue
    const p = line.slice(idx + 3).trim()
    if (p.length === 0 || seen.has(p)) continue
    seen.add(p)
    paths.push(p)
  }
  return paths
}

/** TASK leg. Read the conversation snapshot under `tag` from the store. */
const doTaskLeg = (
  ports: ThreeWayRestorePorts,
  tag: CheckpointTag,
  opts: RestoreOptions | undefined,
): RestoreOutcome => {
  // Resolve the tag FIRST (cheap hermetic check; most-specific error).
  // Misconfigured port comes SECOND.
  const resolved = resolveTag(ports, tag)
  if (resolved.kind === "fail") return resolved.outcome
  if (ports.conversationStore === undefined) {
    return failOutcome(
      tag,
      "conversation-store-not-configured",
      "task leg requires ports.conversationStore to be wired",
    )
  }
  const snapshot = ports.conversationStore.restore(tag)
  if (snapshot === null) {
    return failOutcome(
      tag,
      "task-snapshot-missing",
      `conversation store has no snapshot for tag: ${tag}`,
    )
  }
  const before: ReadonlyArray<Message> = opts?.currentMessages ?? []
  return {
    ok: true,
    message: `task restored from tag ${tag} (${snapshot.length} message${snapshot.length === 1 ? "" : "s"})`,
    tag,
    messagesAfter: snapshot,
    messagesBefore: before,
  }
}

/* ------------------------------------------------------------------ */
/* port                                                                */
/* ------------------------------------------------------------------ */

/** Build the default `ThreeWayRestorePort`. */
export const defaultThreeWayRestore = (ports: ThreeWayRestorePorts): ThreeWayRestorePort => ({
  async restoreFiles(tag, opts) {
    return await doFilesLeg(ports, tag, opts)
  },
  async restoreTask(tag, opts) {
    return doTaskLeg(ports, tag, opts)
  },
  async restoreBoth(tag, opts) {
    const files = await doFilesLeg(ports, tag, opts)
    if (!files.ok) return files
    const task = doTaskLeg(ports, tag, opts)
    if (!task.ok) {
      // Compose: keep the file-leg metadata (filesChanged) on the failure
      // outcome so the surface can show partial success.
      return {
        ok: false,
        errorCode: task.errorCode ?? "task-snapshot-missing",
        message: `files restored OK but task leg failed: ${task.message}`,
        tag,
        ...(files.filesChanged !== undefined ? { filesChanged: files.filesChanged } : {}),
      }
    }
    return {
      ok: true,
      message: `restored BOTH from tag ${tag}: ${files.message}; ${task.message}`,
      tag,
      ...(files.filesChanged !== undefined ? { filesChanged: files.filesChanged } : {}),
      ...(task.messagesAfter !== undefined ? { messagesAfter: task.messagesAfter } : {}),
      ...(task.messagesBefore !== undefined ? { messagesBefore: task.messagesBefore } : {}),
    }
  },
})

/** Test-only re-exports. */
export const __test = {
  failOutcome,
  extractShadowCode,
  resolveTag,
  parseChangedPaths,
  doFilesLeg,
  doTaskLeg,
}
