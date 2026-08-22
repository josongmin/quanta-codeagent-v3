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
  readonly replaceMessages?: (msgs: ReadonlyArray<Message>) => Promise<void>
}

export interface PerToolCheckpointAdapter extends PerToolCheckpointSlashState {}

const notWiredOutcome = (tag: CheckpointTag): RestoreOutcome => ({
  ok: false,
  errorCode: "shadow-odb-not-configured",
  message: "per-tool-checkpoint: restore port not wired in this surface",
  tag,
})

const stubRestorePort = (): ThreeWayRestorePort => ({
  restoreFiles: async (tag: CheckpointTag, _opts?: RestoreOptions): Promise<RestoreOutcome> =>
    notWiredOutcome(tag),
  restoreTask: async (tag: CheckpointTag, _opts?: RestoreOptions): Promise<RestoreOutcome> =>
    notWiredOutcome(tag),
  restoreBoth: async (tag: CheckpointTag, _opts?: RestoreOptions): Promise<RestoreOutcome> =>
    notWiredOutcome(tag),
})

/** Surface adapter for the one granular SHA registry consumed by `/rewind-tool`. */
export const buildPerToolCheckpointAdapter = (
  args: PerToolCheckpointAdapterArgs,
): PerToolCheckpointAdapter => {
  const restore = args.restore ?? stubRestorePort()
  return {
    registry: args.registry,
    restore,
    ...(args.currentMessages !== undefined ? { currentMessages: args.currentMessages } : {}),
    ...(args.replaceMessages !== undefined ? { replaceMessages: args.replaceMessages } : {}),
  }
}
