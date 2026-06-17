/**
 * Fork-session-wire slice barrel (ADR-0284).
 *
 * Composes a default `ConversationCheckpointStore` + base `SessionForker`
 * + rich `ForkSessionPort` into a single bundle the composition root
 * injects via `AgentConfig.forkSession`. Default-OFF: gated on the per-surface
 * `forkSession` boolean — `resolveForkSession(enable)` in agent-arg-builder only
 * wires this bundle when `enable === true` (CLI REPL sets it via
 * `maybeForkSession(args)`; headless hardcodes false). There is NO
 * `QUANTA_FORK_SESSION` env var — the gate is the request flag, not an env knob.
 */

export {
  type CheckpointBaseWire,
  type CheckpointBaseWireOpts,
  defaultCheckpointBaseWire,
} from "./default-checkpoint-base"
