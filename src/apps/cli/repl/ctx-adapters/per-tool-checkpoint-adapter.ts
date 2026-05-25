/**
 * Per-tool checkpoint adapter (ADR-0291 — REPL slash-surface ctx mega-wire).
 *
 * Surface-owned wrapper that surfaces a `GranularRegistry` +
 * `ThreeWayRestorePort` pair to `/rewind-tool`. When the host wires real
 * ports (composition root) the adapter is a 1:1 pass-through; when only
 * the registry is wired (no shadow-odb / no conversation store), every
 * `restoreXxx` arm returns a typed `RestoreOutcome { ok: false, errorCode:
 * "not-yet-wired" }` shape so the slash hellgate seals the contract.
 */

import type {
  CheckpointTag,
  GranularRegistry,
  RestoreOptions,
  RestoreOutcome,
  ThreeWayRestorePort,
} from "@/agent/per-tool-checkpoint"
import type { Message } from "@/llm"
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
