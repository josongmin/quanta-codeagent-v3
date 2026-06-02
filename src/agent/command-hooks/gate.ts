/**
 * Command-hook arming gate + Claude→quanta event mapping (ADR-0454).
 *
 * The gate is the security funnel: a command hook only ever spawns when ALL
 * three guards pass (opt-in + acknowledgement + at least one binding). The
 * permission guard is consulted later, per-event, by the runner — it cannot be
 * resolved synchronously at config time. See {@link CommandHookGate}.
 */

import { DEFAULT_ENV_ALLOWLIST } from "@/runtime"
import {
  COMMAND_HOOKS_ENABLED_WITHOUT_ACK_MESSAGE,
  type CommandHookBinding,
  CommandHookConfigError,
  type CommandHookGate,
  DEFAULT_COMMAND_HOOK_MAX_OUTPUT_BYTES,
  DEFAULT_COMMAND_HOOK_TIMEOUT_MS,
} from "./types"

/** Raw config the host passes (typically derived from `settings.json#hooks`
 *  via {@link loadCommandHookBindings} plus the opt-in toggle + ack from the
 *  env / settings). Every field optional; the canonical "arm it" form is
 *  `{ enabled: true, acknowledgedRisk: "<reason>", bindings: [...] }`. */
export interface CommandHookConfig {
  readonly enabled?: boolean
  readonly acknowledgedRisk?: string
  readonly bindings?: readonly CommandHookBinding[]
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly envAllowlist?: readonly string[]
}

const DISARMED: CommandHookGate = Object.freeze({
  armed: false,
  acknowledgedRisk: undefined,
  bindings: Object.freeze([]),
  timeoutMs: DEFAULT_COMMAND_HOOK_TIMEOUT_MS,
  maxOutputBytes: DEFAULT_COMMAND_HOOK_MAX_OUTPUT_BYTES,
  envAllowlist: Object.freeze([...DEFAULT_ENV_ALLOWLIST]),
})

/**
 * Normalize a raw config into a frozen {@link CommandHookGate}.
 *
 *   - `raw === undefined` OR `enabled !== true` ⇒ DISARMED (default-OFF; the
 *     acknowledgement / bindings are IGNORED — you cannot accidentally arm by
 *     supplying an ack without the explicit toggle);
 *   - `enabled === true` AND `acknowledgedRisk` is a non-empty string ⇒ ARMED
 *     iff there is at least one binding (zero bindings ⇒ nothing to run ⇒
 *     disarmed, byte-identical no-op);
 *   - `enabled === true` AND `acknowledgedRisk` missing / empty / non-string ⇒
 *     throw {@link CommandHookConfigError} (fail fast at startup).
 *
 * Whitespace-only acknowledgement counts as empty — an audit-grade reason, not
 * a single space.
 */
export const normalizeCommandHookGate = (raw: CommandHookConfig | undefined): CommandHookGate => {
  if (raw === undefined || raw.enabled !== true) return DISARMED

  const ack = raw.acknowledgedRisk
  if (typeof ack !== "string" || ack.trim().length === 0) {
    throw new CommandHookConfigError(COMMAND_HOOKS_ENABLED_WITHOUT_ACK_MESSAGE)
  }

  const bindings = (raw.bindings ?? []).filter(
    (b): b is CommandHookBinding =>
      typeof b === "object" &&
      b !== null &&
      typeof b.event === "string" &&
      typeof b.command === "string" &&
      b.command.trim().length > 0,
  )
  if (bindings.length === 0) {
    // Armed toggle + ack but nothing to run — there is no command exec to gate,
    // so the path stays byte-identical to the default. Not an error: a host can
    // legitimately keep the toggle on across a config that happens to have no
    // command hooks for the current repo.
    return Object.freeze({
      armed: false,
      acknowledgedRisk: ack,
      bindings: Object.freeze([]),
      timeoutMs: resolveTimeout(raw.timeoutMs),
      maxOutputBytes: resolveOutputCap(raw.maxOutputBytes),
      envAllowlist: resolveAllowlist(raw.envAllowlist),
    })
  }

  return Object.freeze({
    armed: true,
    acknowledgedRisk: ack,
    bindings: Object.freeze([...bindings]),
    timeoutMs: resolveTimeout(raw.timeoutMs),
    maxOutputBytes: resolveOutputCap(raw.maxOutputBytes),
    envAllowlist: resolveAllowlist(raw.envAllowlist),
  })
}

const resolveTimeout = (v: number | undefined): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_COMMAND_HOOK_TIMEOUT_MS

const resolveOutputCap = (v: number | undefined): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_COMMAND_HOOK_MAX_OUTPUT_BYTES

const resolveAllowlist = (v: readonly string[] | undefined): readonly string[] =>
  v !== undefined && v.length > 0
    ? Object.freeze([...v])
    : Object.freeze([...DEFAULT_ENV_ALLOWLIST])

/** Map a Claude Code hook event name to the quanta {@link HookEventType}.
 *  Returns undefined for events quanta does not model (the binding is skipped
 *  — never thrown). Case-insensitive on the leading char so both `PreToolUse`
 *  and `preToolUse` resolve, matching the loose shapes seen in the wild. */
export const mapClaudeEvent = (
  event: string,
):
  | "pre_tool_use"
  | "post_tool_use"
  | "user_prompt_submit"
  | "session_start"
  | "session_end"
  | "pre_compact"
  | undefined => {
  switch (event) {
    case "PreToolUse":
    case "pre_tool_use":
      return "pre_tool_use"
    case "PostToolUse":
    case "post_tool_use":
      return "post_tool_use"
    case "UserPromptSubmit":
    case "user_prompt_submit":
      return "user_prompt_submit"
    case "SessionStart":
    case "session_start":
      return "session_start"
    case "SessionEnd":
    case "Stop":
    case "session_end":
      return "session_end"
    case "PreCompact":
    case "pre_compact":
      return "pre_compact"
    default:
      return undefined
  }
}
