import type { PermissionContext, PermissionDecision, ToolAction } from "./types"

/** Patterns refused outright regardless of mode. Best-effort, conservative
 *  denylist — NOT a sandbox and NOT an exhaustive policy engine (RFC §1.2:
 *  Phase 1 is a local dev tool). It only blocks the concrete, documented
 *  high-blast-radius bypasses; a determined command can still evade a regex.
 *  Each pattern is tuned to avoid false-positives on legitimate dev commands
 *  (e.g. `rm -rf ./build`, `find . -name x`, `chmod -R 755 ./dist`). */
const HARD_DENY = [
  // rm -rf targeting a root-ish path: `/`, `~`, `$HOME`, or `/*`-style globs
  // (the trailing-glob case covers the `rm -rf /*` path trick).
  /\brm\s+-[a-zA-Z]*[rfRF][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|~|\$HOME|\/\*)(\s|$)/,
  // `find <root> ... -delete` / `-exec rm` sweeping an absolute/home root.
  /\bfind\s+(\/|~|\$HOME)\S*.*-(delete|exec\s+rm)\b/,
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\/dev\//,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
  // chmod/chown recursively from a root-ish path (e.g. `chmod -R 000 /`).
  /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+\S+\s+(\/|~|\$HOME)(\s|$)/,
  // Pipe a network download straight into a shell (`curl … | sh`,
  // `wget … | bash`) — classic remote-code-exec bypass.
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
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
