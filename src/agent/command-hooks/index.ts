/**
 * Disk-configured command hooks (ADR-0454) — public barrel.
 *
 * Default-OFF, security-gated shell execution on HookBus events. See
 * {@link types} for the security model. Nothing here spawns a process unless
 * the gate is ARMED (opt-in + acknowledgement + permission) AND a binding
 * matches the event.
 */

export {
  type CommandHookConfig,
  mapClaudeEvent,
  normalizeCommandHookGate,
} from "./gate"
export { installCommandHooks } from "./install"
export {
  type CommandHookEvent,
  runCommandHooks,
} from "./runner"
export { createSandboxCommandHookExec } from "./sandbox-exec"
export {
  loadCommandHookBindings,
  parseCommandHookBindings,
} from "./settings-loader"
export {
  COMMAND_HOOKS_ENABLED_WITHOUT_ACK_MESSAGE,
  type CommandHookBinding,
  CommandHookConfigError,
  type CommandHookDeps,
  type CommandHookExecOpts,
  type CommandHookExecPort,
  type CommandHookExecResult,
  type CommandHookGate,
  type CommandHookPermissionPort,
  type CommandHookVerdict,
  DEFAULT_COMMAND_HOOK_MAX_OUTPUT_BYTES,
  DEFAULT_COMMAND_HOOK_TIMEOUT_MS,
} from "./types"
