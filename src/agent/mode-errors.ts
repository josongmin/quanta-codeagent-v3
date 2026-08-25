import { QuantaError } from "@/shared"
import type { MutatingToolKind } from "./mode"

export class UnknownToolError extends QuantaError {
  readonly toolName: string

  constructor(toolName: string) {
    super(
      "unknown_tool",
      `Tool "${toolName}" is not classified in the plan-mode mutating table. ` +
        "Every registered tool must have an explicit entry in MUTATING_TOOL_TABLE " +
        "(src/agent/mode.ts) so plan-mode cannot silently allow new mutating tools.",
    )
    this.toolName = toolName
  }
}

export class PlanModeMutatingBlockedError extends QuantaError {
  readonly toolName: string
  readonly mutatingKind: MutatingToolKind

  constructor(toolName: string, mutatingKind: MutatingToolKind) {
    super(
      "plan_mode_mutating_blocked",
      `Tool "${toolName}" (${mutatingKind}) is blocked in plan collaboration mode. ` +
        "Exit plan mode first (for example via `request_plan_exit`), or switch via a developer " +
        "message (`mode=default`) to mutate.",
    )
    this.toolName = toolName
    this.mutatingKind = mutatingKind
  }
}

export class InvalidModeTransitionError extends QuantaError {
  readonly attempted: string

  constructor(attempted: string) {
    super(
      "invalid_mode_transition",
      `Invalid collaboration mode transition: "${attempted}". ` +
        "Only mode=plan and mode=default are allowed via developer message.",
    )
    this.attempted = attempted
  }
}
