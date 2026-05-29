/**
 * Per-tool checkpoint adapter (ADR-0291 — REPL slash-surface ctx mega-wire).
 *
 * Surface-owned wrapper that surfaces a `GranularRegistry` +
 * `ThreeWayRestorePort` pair to `/rewind-tool`. When the host wires real
 * ports (composition root) the adapter is a 1:1 pass-through; when only
 * the registry is wired (no shadow-odb / no conversation store), every
 * `restoreXxx` arm returns a typed `RestoreOutcome { ok: false, errorCode:
 * "not-yet-wired" }` shape so the slash hellgate seals the contract.
 *
 * ADR-0300 sibling factory: `createPerToolCheckpointAdapter` consumes a
 * `GranularRegistryPort` (in-memory snapshot store, sibling of the
 * shadow-ODB tag registry used by `buildPerToolCheckpointAdapter`). When
 * the snapshot registry is supplied, the 3-way restore arms return the
 * stored `filesBefore` + `taskMessagesBefore` payloads directly. When
 * absent, every arm returns the existing `shadow-odb-not-configured` Err
 * (default-OFF byte-identical for every legacy caller).
 */

import type { GranularRegistryPort, ToolSnapshot } from "@/agent/checkpoint/granular-registry"
import type {
  CheckpointTag,
  GranularRegistry,
  RestoreOptions,
  RestoreOutcome,
  ThreeWayRestorePort,
} from "@/agent/per-tool-checkpoint"
import type { Message } from "@/llm"
import { errMessage } from "@/shared"
import type { PerToolCheckpointSlashState } from "../../rewind-tool-cmd"
export interface PerToolCheckpointAdapterArgs {
  readonly registry: GranularRegistry
  readonly restore?: ThreeWayRestorePort
  readonly currentMessages?: () => ReadonlyArray<Message>
}

export interface PerToolCheckpointAdapter extends PerToolCheckpointSlashState {}

/** Build a `RestoreOutcome` with the not-yet-wired typed error code. We
 *  re-use `shadow-odb-not-configured` (closed enum in port.ts) as the
 *  best-match symbolic code — the slash UI surfaces it verbatim via
 *  `renderOutcome`. */
const notWiredOutcome = (tag: CheckpointTag): RestoreOutcome => ({
  ok: false,
  errorCode: "shadow-odb-not-configured",
  message: "per-tool-checkpoint: restore port not wired in this surface",
  tag,
})

/** Stub port used when only the registry is supplied. Every arm returns
 *  the typed not-wired outcome — the slash never crashes, the hellgate
 *  pins the shape. */
const stubRestorePort = (): ThreeWayRestorePort => ({
  restoreFiles: async (tag: CheckpointTag, _opts?: RestoreOptions): Promise<RestoreOutcome> =>
    notWiredOutcome(tag),
  restoreTask: async (tag: CheckpointTag, _opts?: RestoreOptions): Promise<RestoreOutcome> =>
    notWiredOutcome(tag),
  restoreBoth: async (tag: CheckpointTag, _opts?: RestoreOptions): Promise<RestoreOutcome> =>
    notWiredOutcome(tag),
})

/** Build the adapter. When `restore` is omitted, a typed stub fills the
 *  slot so the slash command still resolves tag prefixes against the
 *  registry. */
export const buildPerToolCheckpointAdapter = (
  args: PerToolCheckpointAdapterArgs,
): PerToolCheckpointAdapter => {
  const restore = args.restore ?? stubRestorePort()
  return args.currentMessages !== undefined
    ? { registry: args.registry, restore, currentMessages: args.currentMessages }
    : { registry: args.registry, restore }
}

/* ------------------------------------------------------------------ */
/* ADR-0300 — snapshot-registry sibling factory                        */
/* ------------------------------------------------------------------ */

/** Typed result of one snapshot-registry restore arm. Mirrors the
 *  shape of `RestoreOutcome` but carries the raw `files` / `messages`
 *  payloads from the snapshot (not shadow-ODB SHAs). Closed-port —
 *  expanding requires an ADR amendment. */
export type SnapshotRestoreResult =
  | {
      readonly ok: true
      readonly toolCallId: string
      readonly files?: ReadonlyMap<string, string>
      readonly messages?: ReadonlyArray<Message>
    }
  | {
      readonly ok: false
      readonly errorCode: "shadow-odb-not-configured" | "not-found" | "registry-failure"
      readonly toolCallId: string
      readonly message: string
    }

/** Closed-port surface returned by {@link createPerToolCheckpointAdapter}.
 *  3 sibling arms — `restoreFiles` returns ONLY the files map,
 *  `restoreTask` returns ONLY the messages array, `restoreBoth` returns
 *  both. NO-THROW: every failure collapses to the typed `ok:false`
 *  envelope above. */
export interface PerToolCheckpointSnapshotAdapter {
  restoreFiles(toolCallId: string): SnapshotRestoreResult
  restoreTask(toolCallId: string): SnapshotRestoreResult
  restoreBoth(toolCallId: string): SnapshotRestoreResult
}

/** Construction opts for the sibling factory. */
export interface CreatePerToolCheckpointAdapterOpts {
  /** Per-tool snapshot port. Absent ⇒ every `restoreXxx` arm returns
   *  the legacy `shadow-odb-not-configured` Err (default-OFF byte-
   *  identical with the existing T1 stub posture). */
  readonly registry?: GranularRegistryPort
}

const notWired = (toolCallId: string): SnapshotRestoreResult => ({
  ok: false,
  errorCode: "shadow-odb-not-configured",
  toolCallId,
  message: "per-tool-checkpoint: granular registry not wired in this surface",
})

const notFound = (toolCallId: string): SnapshotRestoreResult => ({
  ok: false,
  errorCode: "not-found",
  toolCallId,
  message: `per-tool-checkpoint: no snapshot for toolCallId=${toolCallId}`,
})

const registryFailure = (toolCallId: string, err: unknown): SnapshotRestoreResult => ({
  ok: false,
  errorCode: "registry-failure",
  toolCallId,
  message: `per-tool-checkpoint: registry threw: ${errMessage(err)}`,
})

/** Try to read a snapshot from the registry. NO-THROW — wraps the call
 *  in try/catch so a misbehaving (caller-supplied) registry can't crash
 *  the surface. */
const safeRestore = (
  registry: GranularRegistryPort,
  toolCallId: string,
): { kind: "ok"; snap: ToolSnapshot } | { kind: "miss" } | { kind: "throw"; err: unknown } => {
  try {
    const snap = registry.restore(toolCallId)
    return snap === null ? { kind: "miss" } : { kind: "ok", snap }
  } catch (err) {
    return { kind: "throw", err }
  }
}

/**
 * ADR-0300 sibling factory. Consumes a `GranularRegistryPort` (in-memory
 * `ToolSnapshot` store) and surfaces the 3-way restore arms over the
 * stored `filesBefore` / `taskMessagesBefore` payloads.
 *
 * When `opts.registry` is absent every arm returns the typed
 * `shadow-odb-not-configured` Err so the surface contract stays
 * byte-identical (default-OFF posture mirroring the existing T1
 * `stubRestorePort`).
 */
export const createPerToolCheckpointAdapter = (
  opts?: CreatePerToolCheckpointAdapterOpts,
): PerToolCheckpointSnapshotAdapter => {
  const registry = opts?.registry
  if (registry === undefined) {
    return {
      restoreFiles: (toolCallId) => notWired(toolCallId),
      restoreTask: (toolCallId) => notWired(toolCallId),
      restoreBoth: (toolCallId) => notWired(toolCallId),
    }
  }

  return {
    restoreFiles(toolCallId) {
      const r = safeRestore(registry, toolCallId)
      if (r.kind === "throw") return registryFailure(toolCallId, r.err)
      if (r.kind === "miss") return notFound(toolCallId)
      return { ok: true, toolCallId, files: r.snap.filesBefore }
    },
    restoreTask(toolCallId) {
      const r = safeRestore(registry, toolCallId)
      if (r.kind === "throw") return registryFailure(toolCallId, r.err)
      if (r.kind === "miss") return notFound(toolCallId)
      return { ok: true, toolCallId, messages: r.snap.taskMessagesBefore }
    },
    restoreBoth(toolCallId) {
      const r = safeRestore(registry, toolCallId)
      if (r.kind === "throw") return registryFailure(toolCallId, r.err)
      if (r.kind === "miss") return notFound(toolCallId)
      return {
        ok: true,
        toolCallId,
        files: r.snap.filesBefore,
        messages: r.snap.taskMessagesBefore,
      }
    },
  }
}
