/**
 * ADR-0416 — Subagent mailbox slice barrel.
 *
 * The ONLY allowed import path for the inter-agent mailbox model + store.
 * Importing this barrel allocates nothing and mutates no process state until a
 * host calls `createSubagentMailbox()`. Pure leaf (`@/shared` + zod adjacent —
 * the store itself depends only on `node:crypto`). NOT a `@/agent` core import.
 */

export {
  createPeerInboxDrain,
  formatPeerBody,
  type PeerInboxAdapterOptions,
} from "./peer-inbox"
export {
  createDefaultSubagentMailbox,
  createSubagentMailbox,
  DEFAULT_SUBAGENT_MAILBOX_MAX_UNDELIVERED_PER_SENDER,
} from "./store"
export {
  type PeerMessageNotice,
  type PeerMessageProvenance,
  type PeerMessageSink,
  type SurfaceNotifyOptions,
  surfaceNotifyMailbox,
} from "./surface-notify"
export {
  type TeamMembershipGate,
  teamScopedMailbox,
} from "./team-scoped"
export {
  ROOT_MAILBOX_AGENT_ID,
  rootMailboxRecipient,
} from "./types"
export type {
  CreateSubagentMailboxOptions,
  MailboxMessage,
  MailboxMessageKind,
  MailboxPort,
  MailboxSnapshot,
} from "./types"
