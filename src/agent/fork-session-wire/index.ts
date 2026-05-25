/**
 * Fork-session-wire slice barrel (ADR-0284).
 *
 * Composes a default `ConversationCheckpointStore` + base `SessionForker`
 * + rich `ForkSessionPort` into a single bundle the composition root
 * injects via `AgentConfig.forkSession`. Default-OFF: gated on
 * `QUANTA_FORK_SESSION=on` at the composition root.
 */

export {
  type CheckpointBaseWire,
  type CheckpointBaseWireOpts,
  defaultCheckpointBaseWire,
} from "./default-checkpoint-base"
