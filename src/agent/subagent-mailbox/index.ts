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
export { createSubagentMailbox } from "./store"
export {
  type TeamMembershipGate,
  teamScopedMailbox,
} from "./team-scoped"
export type {
  CreateSubagentMailboxOptions,
  MailboxMessage,
  MailboxMessageKind,
  MailboxPort,
  MailboxSnapshot,
} from "./types"
