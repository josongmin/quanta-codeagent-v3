/**
 * `@/agent/user-question` — RFC-01 A3 attention PRODUCER barrel.
 *
 * The producer adapts `request_user_input` through the `@/session/user-question`
 * broker (the pending-question authority A2's `AttentionReader` joins). `@/agent`
 * is the legal cross-slice bridge (blueprint §5); this slice owns ONLY the
 * producer, not the projection (which is A2's session-authorities reader).
 */

export { questionOwnerFor } from "./task-correlation"
export { bindBrokerUserInputPort } from "./tool-adapter"
