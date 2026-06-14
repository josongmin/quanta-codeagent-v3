/**
 * T07 — thin VS Code glue for the `chatSessions` editor surface.
 *
 * This is the ONLY file in the integration that imports `vscode`. It owns NO
 * projection logic: it re-shapes the pure {@link ChatSessionItemView} produced
 * by {@link ChatSessionRegistry} into the concrete `vscode.ChatSessionItem`,
 * re-maps the version-stable {@link CHAT_SESSION_STATUS} onto the proposed
 * `vscode.ChatSessionStatus` enum of the targeted build, and forwards the
 * registry's coalesced change event to VS Code. Everything testable lives in
 * `chat-session-adapter.ts` (no `vscode`); this shell is verified only by the
 * integration smoke a packaged extension run provides.
 *
 * Core-decoupling: nothing under `src/` imports this module — proved by
 * `core-no-vscode-leak-ratchet.test.ts`.
 */
import * as vscode from "vscode"
import {
  type ChatSessionItemView,
  ChatSessionRegistry,
  type SessionPort,
} from "./chat-session-adapter"
import { CHAT_SESSION_STATUS, type ChatSessionStatusValue } from "./status"

/** The chat session TYPE this extension contributes (matches package.json
 *  `contributes.chatSessions[].type` and the `quanta-thread` document scheme). */
export const QUANTA_CHAT_SESSION_TYPE = "quanta-thread"

/**
 * Re-map the version-stable adapter status onto the targeted build's proposed
 * `ChatSessionStatus`. Centralized here (NOT in the pure adapter) so an enum
 * change in a future VS Code build is a one-line edit that never touches core.
 */
const STATUS_TO_VSCODE: Record<ChatSessionStatusValue, vscode.ChatSessionStatus> = {
  [CHAT_SESSION_STATUS.InProgress]: vscode.ChatSessionStatus.InProgress,
  [CHAT_SESSION_STATUS.Idle]: vscode.ChatSessionStatus.Completed,
  [CHAT_SESSION_STATUS.Failed]: vscode.ChatSessionStatus.Failed,
}

const toVscodeItem = (view: ChatSessionItemView): vscode.ChatSessionItem => ({
  id: view.id,
  label: view.label,
  status: STATUS_TO_VSCODE[view.status],
  ...(view.timing !== undefined ? { timing: { ...view.timing } } : {}),
})

/**
 * Build a `vscode.ChatSessionItemProvider` backed by the pure registry, and
 * register it. `createSession` is the host's app-server entry: it launches /
 * connects a quanta session and returns a {@link SessionPort}.
 */
export const registerQuantaChatSessions = (
  createSession: () => Promise<SessionPort>,
): vscode.Disposable => {
  const registry = new ChatSessionRegistry({ createSession })
  const changeEmitter = new vscode.EventEmitter<void>()
  const unsub = registry.onDidChangeItems(() => changeEmitter.fire())

  const provider: vscode.ChatSessionItemProvider = {
    onDidChangeChatSessionItems: changeEmitter.event,
    provideChatSessionItems: () => registry.items().map(toVscodeItem),
    provideNewChatSessionItem: async () => {
      const projection = await registry.createNew()
      return toVscodeItem(projection.current())
    },
  }

  const registration = vscode.chat.registerChatSessionItemProvider(
    QUANTA_CHAT_SESSION_TYPE,
    provider,
  )

  return {
    dispose: () => {
      unsub()
      registration.dispose()
      changeEmitter.dispose()
      registry.dispose()
    },
  }
}
