/**
 * Side-chat slice barrel (ADR-0244). Plane-clean helper primitive.
 *
 * Default-OFF: the composition root must explicitly instantiate
 * `defaultSideChatManager()` for any side-chat surface to be reachable.
 * Until then, this slice is dead weight from the loop's perspective —
 * `buildSessionFeatures` does not consume it (HELL-SC-12).
 */

export type { DefaultSideChatManagerOpts } from "./default-manager"
export { defaultSideChatManager } from "./default-manager"
export type {
  SideChatCloseAllInput,
  SideChatListInput,
  SideChatManager,
  SideChatSendInput,
  SideChatSendResult,
  SideChatStartInput,
  SideChatStartResult,
  SideChatStopInput,
  SideChatStopResult,
} from "./port"
export type {
  SideChatError,
  SideChatId,
  SideChatMessage,
  SideChatState,
} from "./types"
export {
  ALL_SIDE_CHAT_ERROR_CODES,
  ALL_SIDE_CHAT_STATES,
} from "./types"
