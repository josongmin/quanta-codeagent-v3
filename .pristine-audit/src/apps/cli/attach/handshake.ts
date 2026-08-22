/**
 * session.v1 connect-handshake driver — CONSUMER SHIM (S3, jul-16 SDK ticket
 * 01). The pure discovery→adopt driver MOVED to `@/ipc/session/attach-flow`
 * so the CLI attach client and the public SDK `connect()` door share ONE
 * handshake implementation (SSOT hoist, not a copy). This module re-exports
 * it under the attach slice's historical names — every existing import site
 * (`@/apps/cli/attach`) keeps working unmodified, which is the behavior-
 * preservation proof for the move.
 */

export type { AttachHandshake } from "@/ipc/session"
export { createAttachHandshake, HANDSHAKE_DISCOVERY_SESSION_ID } from "@/ipc/session"
