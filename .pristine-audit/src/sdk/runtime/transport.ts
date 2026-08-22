import type { ConnectedSessionTransport, SessionTransport } from "@/ipc/session"
import type { RuntimeSession } from "./types"

export interface AttachSessionTransportArgs {
  readonly session: RuntimeSession
  readonly transport: SessionTransport
  readonly replayWindow?: number
}

export interface AttachedSessionTransport {
  close(): Promise<void>
}

export const attachSessionTransport = async (
  args: AttachSessionTransportArgs,
): Promise<AttachedSessionTransport> => {
  return await args.session.attachSessionTransport(args.transport, {
    ...(args.replayWindow !== undefined ? { replayWindow: args.replayWindow } : {}),
  })
}

export const detachSessionTransport = async (
  handle: AttachedSessionTransport | ConnectedSessionTransport,
): Promise<void> => {
  await handle.close()
}
