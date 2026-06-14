/**
 * Conversation-action surface — RE-EXPORT shim (T02).
 *
 * The implementation was HOISTED to `@/agent/conversation-action-surface` so the
 * web daemon can mint the same surface (the slice-isolation fence forbids the
 * daemon importing `apps/cli/**`). This file preserves the historic CLI import
 * path (`./conversation-action-surface`, `@/apps/cli/repl/conversation-action-
 * surface`) so every existing CLI importer + hellgate stays byte-identical.
 */
export {
  type ConversationActionSurface,
  createConversationActionSurface,
} from "@/agent/conversation-action-surface"
