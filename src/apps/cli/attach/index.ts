/**
 * CLI "attach to a running daemon" slice.
 *
 * Turns the in-process-only CLI into a WS client of a daemon's shared
 * session.v1 endpoint: discovery→adopt handshake, live event rendering,
 * stdin→command, and approval prompting. Wired via the `attach` subcommand in
 * `src/apps/cli/index.ts`; default-OFF (inert unless the subcommand is typed).
 */

export type {
  AttachedSession,
  AttachSocket,
  AttachSocketCtor,
  AttachToDaemonOptions,
} from "./attach-client"
export { attachToDaemon } from "./attach-client"
export type { BuildApprovalRespondArgs, BuildLineCommandsArgs } from "./commands"
export { buildApprovalRespondCommand, buildLineCommands } from "./commands"
export type { AttachHandshake } from "./handshake"
export { createAttachHandshake, HANDSHAKE_DISCOVERY_SESSION_ID } from "./handshake"
export { renderSessionEvent } from "./render"
