import { type AutoModeClassifier, CLASSIFIER_SYSTEM_PROMPT } from "./classifier"
import type { PermissionContext, PermissionDecision, ToolAction } from "./types"

/** Patterns refused outright regardless of mode. Best-effort, conservative
 *  denylist — NOT a sandbox and NOT an exhaustive policy engine (RFC §1.2:
 *  Phase 1 is a local dev tool). It only blocks the concrete, documented
 *  high-blast-radius bypasses; a determined command can still evade a regex.
 *  Each pattern is tuned to avoid false-positives on legitimate dev commands
 *  (e.g. `rm -rf ./build`, `find . -name x`, `chmod -R 755 ./dist`). */
const HARD_DENY = [
  // Recursive+force `rm` aimed at a root-ish target. The prior pattern only
  // fired when the root token was the WHOLE final arg, so `rm -rf ~/.ssh`,
  // `rm -rf /etc`, `rm -rf $HOME/.ssh`, `rm --recursive --force /` all slipped
  // through. We now require BOTH a recursive flag (`-r`/`-R`/`--recursive`, or
  // a combined short cluster containing r/R) AND a force flag (`-f`/`-F`/
  // `--force`, or a combined cluster containing f/F), in ANY order, possibly
  // split across separate args — then a dangerous target with an optional
  // path SUFFIX: `/`, `~`, `~/…`, `$HOME`, `$HOME/…`, `${HOME}`, `${HOME}/…`,
  // a bare `/*` glob, OR an absolute system root (`/etc`,`/usr`,`/var`,`/bin`,
  // `/sbin`,`/lib`,`/lib64`,`/opt`,`/root`,`/boot`,`/dev`,`/sys`,`/proc`,
  // `/home`,`/srv`,`/run`,`/mnt`,`/media`). Still a best-effort denylist
  // (RFC §1.2): project-relative / `/tmp` targets stay ALLOWED — `rm -rf
  // ./build`, `rm -rf node_modules`, `rm -rf dist/`, `rm -rf /tmp/x` do NOT
  // match (no system-root prefix; `/tmp` is deliberately excluded).
  /\brm\b(?=(?:\s+-(?:[a-zA-Z]*[rR][a-zA-Z]*|-recursive\b))(?:\s|$)|[\s\S]*?\s-(?:[a-zA-Z]*[rR][a-zA-Z]*|-recursive)\b)(?=(?:\s|[\s\S])*?\s-(?:[a-zA-Z]*[fF][a-zA-Z]*|-force)\b)[\s\S]*?\s(?:\$\{?HOME\}?|~|\/(?:\*|etc|usr|var|bin|sbin|lib64|lib|opt|root|boot|dev|sys|proc|home|srv|run|mnt|media)?)(?:\/\S*)?(?=\s|$|;|&|\|)/,
  // `find <root> ... -delete` / `-exec rm` sweeping an absolute/home root.
  /\bfind\s+(\/|~|\$HOME)\S*.*-(delete|exec\s+rm)\b/,
  // PATH-INDEPENDENT: dangerous `find` action-flags fire regardless of where
  // `find` is rooted (the bash-sandbox.md `w05` set: -delete, -exec, -execdir,
  // -fprintf, -fprint/-fprint0, -ok, -okdir, -fls). `find . -name x` /
  // `find ./src -type f -print` stay legit — only the action-flag set blocks.
  /\bfind\b[\s\S]*?\s-(delete|exec|execdir|fprintf|fprint0?|fls|ok|okdir)\b/,
  // PATH-INDEPENDENT git config-injection (bash-sandbox.md §2.6 / 3.4):
  // `git -c <anything>` arbitrary config override (lowercase -c only; the
  // legit `git -C <dir>` capital-C must still pass — JS regex is case-sensitive
  // so `-c` will not match `-C`).
  /\bgit\b[\s\S]*?\s-c[\s=]/,
  // `git --exec-path[=...]` (hijack git's helper exec dir).
  /\bgit\b[\s\S]*?\s--exec-path\b/,
  // `git --config-env[=...]` (config value sourced from attacker-set env var).
  /\bgit\b[\s\S]*?\s--config-env\b/,
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\/dev\//,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
  // chmod/chown recursively from a root-ish path (e.g. `chmod -R 000 /`).
  /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+\S+\s+(\/|~|\$HOME)(\s|$)/,
  // Pipe a network download straight into a shell (`curl … | sh`,
  // `wget … | bash`) — classic remote-code-exec bypass.
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
  // `shutdown`/`reboot`/`halt` as an actual COMMAND (segment start or after
  // a `;`/`&&`/`||`/`|` separator, optional `sudo`) — NOT the bare word inside
  // a path, filename, or commit message (`git commit -m "fix shutdown race"`
  // must still pass; `sudo shutdown -h now` / `x && reboot` must not).
  /(?:^|[;&|]|\bsudo\s+)\s*(?:shutdown|reboot|halt)\b/,
]

const bashCommand = (input: unknown): string => {
  if (input && typeof input === "object" && "command" in input) {
    const c = (input as { command: unknown }).command
    return typeof c === "string" ? c : ""
  }
  return ""
}

/** Returns the HARD_DENY decision for a bash action, or null if it does not
 *  match. Path-independent dangerous patterns always win first, before mode. */
const hardDeny = (action: ToolAction): PermissionDecision | null => {
  if (action.tool !== "bash") return null
  const cmd = bashCommand(action.input)
  for (const pat of HARD_DENY) {
    if (pat.test(cmd)) return { kind: "deny", reason: `Blocked dangerous command: ${cmd}` }
  }
  return null
}

/** Phase 1 policy: read-only always allowed; destructive shell hard-denied;
 *  everything else allowed in `bypass`/`acceptEdits`, asked in `default`.
 *
 *  "auto" mode is async (needs the injected classifier) — this synchronous
 *  entrypoint cannot await it, so it degrades "auto" safely to "ask" after
 *  applying the read-only allow and the HARD_DENY guard. The main thread
 *  should call `evaluateAuto()` instead when it can drive the classifier. */
export const evaluate = (action: ToolAction, ctx: PermissionContext): PermissionDecision => {
  if (action.isReadOnly) return { kind: "allow" }

  const denied = hardDeny(action)
  if (denied) return denied

  if (ctx.mode === "bypass" || ctx.mode === "acceptEdits") return { kind: "allow" }
  if (ctx.mode === "auto") {
    return {
      kind: "ask",
      reason: "auto mode requires the async classifier (use evaluateAuto)",
    }
  }
  return { kind: "ask", reason: `${action.tool} modifies state` }
}

/**
 * Async permission evaluation for "auto" mode. Ordering (permission-system.md
 * §3.5): read-only → allow; HARD_DENY still wins first; otherwise consult the
 * injected classifier via the stateful AutoModeClassifier. A `fallback`
 * verdict from the classifier (denial-limit exceeded, circuit-broken, or
 * classifier absent) surfaces as a hard "ask".
 *
 * Behavior-preserving for the 3 existing modes: anything that is not "auto"
 * delegates verbatim to the synchronous `evaluate()`.
 */
export const evaluateAuto = async (
  action: ToolAction,
  ctx: PermissionContext,
  classifier: AutoModeClassifier,
): Promise<PermissionDecision> => {
  if (ctx.mode !== "auto") return evaluate(action, ctx)

  if (action.isReadOnly) return { kind: "allow" }

  // HARD_DENY beats the classifier — it crosses a security boundary and no
  // user/model context authorizes it.
  const denied = hardDeny(action)
  if (denied) return denied

  const decision = await classifier.evaluate({
    tool: action.tool,
    input: action.input,
    systemPrompt: ctx.classify
      ? // The injected port owns the real system prompt; pass the canonical
        // taxonomy so a mock/echo port still sees the SOTA wording.
        CLASSIFIER_SYSTEM_PROMPT
      : "",
  })

  if (decision.fallback) return { kind: "ask", reason: decision.reason }
  if (decision.verdict === "allow") return { kind: "allow" }
  if (decision.verdict === "deny") return { kind: "deny", reason: decision.reason }
  return { kind: "ask", reason: decision.reason }
}
