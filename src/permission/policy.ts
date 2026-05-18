import type { PermissionContext, PermissionDecision, ToolAction } from "./types"

/** Patterns that are refused outright regardless of mode. Intentionally tiny
 *  — Phase 1 is a local dev tool, not a sandbox. Hardening is a later phase. */
const HARD_DENY = [
  /\brm\s+-[rfRF]{1,2}\s+(\/|~|\$HOME)(\s|$)/,
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\/dev\//,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
  /\b(shutdown|reboot|halt)\b/,
]

const bashCommand = (input: unknown): string => {
  if (input && typeof input === "object" && "command" in input) {
    const c = (input as { command: unknown }).command
    return typeof c === "string" ? c : ""
  }
  return ""
}

/** Phase 1 policy: read-only always allowed; destructive shell hard-denied;
 *  everything else allowed in `bypass`/`acceptEdits`, asked in `default`. */
export const evaluate = (action: ToolAction, ctx: PermissionContext): PermissionDecision => {
  if (action.isReadOnly) return { kind: "allow" }

  if (action.tool === "bash") {
    const cmd = bashCommand(action.input)
    for (const pat of HARD_DENY) {
      if (pat.test(cmd)) return { kind: "deny", reason: `Blocked dangerous command: ${cmd}` }
    }
  }

  if (ctx.mode === "bypass" || ctx.mode === "acceptEdits") return { kind: "allow" }
  return { kind: "ask", reason: `${action.tool} modifies state` }
}
