import { type AutoModeClassifier, CLASSIFIER_SYSTEM_PROMPT } from "./classifier"
import type { HITLTier, PermissionContext, PermissionDecision, ToolAction } from "./types"

/** Patterns refused outright regardless of mode. Best-effort, conservative
 *  denylist — NOT a sandbox and NOT an exhaustive policy engine (RFC §1.2:
 *  Phase 1 is a local dev tool). It only blocks the concrete, documented
 *  high-blast-radius bypasses; a determined command can still evade a regex.
 *  Each pattern is tuned to avoid false-positives on legitimate dev commands
 *  (e.g. `rm -rf ./build`, `find . -name x`, `chmod -R 755 ./dist`). */
/**
 * Shell interpreter family used in pipe-to-shell guards. Includes POSIX +
 * extended shells (`ksh`, `csh`/`tcsh`, `ash`) and the non-POSIX entries
 * `fish`, `pwsh`, plus macOS `osascript` (which on macOS executes
 * AppleScript / JavaScript-for-Automation — a full RCE channel that the
 * narrower `(ba|z|da)?sh` set missed). Any new shell entry here MUST stay
 * a static literal — no user input — so the regex engine can't be
 * influenced by attacker-controlled text.
 */
const SHELL_GROUP = "(?:(?:ba|z|da|k|c|tc|a)?sh|fish|pwsh|osascript)"

/**
 * Script-interpreter family for the `curl … | <interp>` RCE bypass. The
 * baseline set covers POSIX scripting languages; the additions catch the
 * modern + macOS attack surface that previously slipped past:
 *   - `lua` — common embedded scripting interp.
 *   - `osascript` — macOS AppleScript / JXA executor.
 *   - `pwsh` — PowerShell Core (cross-platform).
 *   - `deno`, `bun` — modern JS/TS runtimes.
 *   - `tsx` — `ts-node`/tsx pipe execution.
 *   - `swift` — macOS Swift script runner.
 */
const INTERP_GROUP = "(?:python[0-9.]*|perl|node|ruby|php|lua|osascript|pwsh|deno|bun|tsx|swift)"

/**
 * Network-egress / exfiltration channel family. The original set (`curl`,
 * `wget`, `nc`, `ncat`, `socat`, `telnet`) only covered direct
 * stdout-piping tools; an attacker who can also reach for `openssl s_client`,
 * `ssh`/`scp`/`sftp`/`rsync`, `mail`/`sendmail`/`mailx`, `ftp`/`tftp`, or a
 * cloud-CLI uploader (`aws`, `gh`, `gcloud`, `az`) has equivalent
 * exfiltration capability. Adding them closes the documented
 * credential-exfil bypass classes.
 */
const EXFIL_GROUP =
  "(?:curl|wget|nc|ncat|socat|telnet|openssl|ssh|scp|sftp|rsync|mail|sendmail|mailx|ftp|tftp|aws|gh|gcloud|az)"

/**
 * Anchored-on-`/` system root token set for the `rm -rf` / `chmod -R` /
 * `find` guards. The original set covered the Linux FHS (`/etc`, `/usr`,
 * `/var`, …). We add the macOS top-level directories:
 *   - `Users` — every user's home tree lives here.
 *   - `Library` — system + user library state.
 *   - `Applications` — installed apps.
 *   - `System`, `Network`, `Volumes`, `private` — macOS system roots.
 * All entries are matched as an absolute root (the surrounding pattern
 * requires a leading `/`), so a project-relative `./Users/foo` does NOT
 * match — only `/Users/...` does.
 */
const SYSTEM_ROOTS =
  "etc|usr|var|bin|sbin|lib64|lib|opt|root|boot|dev|sys|proc|home|srv|run|mnt|media|Users|Library|Applications|System|Network|Volumes|private"

const HARD_DENY = [
  // Recursive+force `rm` aimed at a root-ish target. The prior pattern only
  // fired when the root token was the WHOLE final arg, so `rm -rf ~/.ssh`,
  // `rm -rf /etc`, `rm -rf $HOME/.ssh`, `rm --recursive --force /` all slipped
  // through. We now require BOTH a recursive flag (`-r`/`-R`/`--recursive`, or
  // a combined short cluster containing r/R) AND a force flag (`-f`/`-F`/
  // `--force`, or a combined cluster containing f/F), in ANY order, possibly
  // split across separate args — then a dangerous target with an optional
  // path SUFFIX: `/`, `~`, `~/…`, `$HOME`, `$HOME/…`, `${HOME}`, `${HOME}/…`,
  // a bare `/*` glob, OR an absolute system root (`/etc`,`/usr`,`/Users`,
  // `/Library`,`/Applications`,`/System`,`/Volumes`,`/private`, …). Still
  // best-effort (RFC §1.2): project-relative / `/tmp` targets stay ALLOWED.
  new RegExp(
    String.raw`\brm\b(?=(?:\s+-(?:[a-zA-Z]*[rR][a-zA-Z]*|-recursive\b))(?:\s|$)|[\s\S]*?\s-(?:[a-zA-Z]*[rR][a-zA-Z]*|-recursive)\b)(?=(?:\s|[\s\S])*?\s-(?:[a-zA-Z]*[fF][a-zA-Z]*|-force)\b)[\s\S]*?\s(?:\$\{?HOME\}?|~|\/(?:\*|${SYSTEM_ROOTS})?)(?:\/\S*)?(?=\s|$|;|&|\|)`,
  ),
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
  // `wget … | bash`, `… | fish`, `… | pwsh`, `… | osascript`) — classic RCE
  // bypass. Includes ksh/csh/tcsh/ash on top of the original ba/z/da set.
  new RegExp(String.raw`\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?${SHELL_GROUP}\b`),
  // `shutdown`/`reboot`/`halt` as an actual COMMAND (segment start or after
  // a `;`/`&&`/`||`/`|` separator, optional `sudo`) — NOT the bare word inside
  // a path, filename, or commit message (`git commit -m "fix shutdown race"`
  // must still pass; `sudo shutdown -h now` / `x && reboot` must not).
  /(?:^|[;&|]|\bsudo\s+)\s*(?:shutdown|reboot|halt)\b/,
  // S7b — credential exfiltration: reading a well-known local secret store
  // and piping it into a network sender. Channel set extended beyond the
  // direct curl/wget/nc family to also catch `openssl`/`ssh`/`scp`/`sftp`/
  // `rsync`/`mail`/`sendmail`/`mailx`/`ftp`/`tftp`/cloud CLIs (`aws`/`gh`/
  // `gcloud`/`az`) — any of them is an equivalent exfil channel.
  new RegExp(
    String.raw`(?:~\/\.ssh\b|\$HOME\/\.ssh\b|\.aws\/credentials\b|\bid_rsa\b|\.netrc\b|\.pgpass\b|~\/\.gnupg\b|(?:^|[\s/'"=])\.env(?:\.\w+)?\b)[\s\S]*?\|\s*(?:sudo\s+)?${EXFIL_GROUP}\b`,
  ),
  // S7b — `base64 … | sh|bash|zsh|dash|ksh|csh|fish|pwsh|osascript` (decode-
  // then-execute RCE bypass). `base64 file.png` with no pipe stays ALLOWED.
  new RegExp(String.raw`\bbase64\b[^|]*\|\s*(?:sudo\s+)?${SHELL_GROUP}\b`),
  // S7b — pipe a network download straight into a script interpreter
  // (`curl … | python`, `wget … | perl|node|ruby|php|lua|osascript|pwsh|
  // deno|bun|tsx|swift`) — the interpreter analogue of `curl … | sh`.
  // `curl … -o f.json` (no pipe) and `cat f | python script.py` (no
  // curl/wget) stay ALLOWED.
  new RegExp(String.raw`\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?${INTERP_GROUP}\b`),
  // S7b — raw write to a block device by redirection or `dd`/`tee` (disk
  // wipe / partition-table clobber). Broadens the existing `dd of=/dev/`
  // entry to common device prefixes and the `>`/`tee` forms. `dd if=in
  // of=./out` and `echo x > ./file` stay ALLOWED (no /dev/ block target).
  /(?:>\s*|of=|tee\s+(?:-\S+\s+)*)\/dev\/(?:sd|hd|nvme|vd|xvd|mmcblk|loop|dm-|disk\d|rdisk\d)/,
]

const bashCommand = (input: unknown): string => {
  if (input && typeof input === "object" && "command" in input) {
    const c = (input as { command: unknown }).command
    return typeof c === "string" ? c : ""
  }
  return ""
}

/** Returns the HARD_DENY reason string for a bash action, or null if it does
 *  not match. Path-independent dangerous patterns always win first, before
 *  mode. HARD_DENY hits ARE the `hand-off-required` tier — they cross a
 *  security boundary that no agent mode can authorize. Exposed so the
 *  dispatch seam can phrase the deny message as a human-handoff request when
 *  the HITL 4-tier gate is enabled. */
export const hardDenyReason = (action: ToolAction): string | null => {
  if (action.tool !== "bash") return null
  const cmd = bashCommand(action.input)
  for (const pat of HARD_DENY) {
    if (pat.test(cmd)) return `Blocked dangerous command: ${cmd}`
  }
  return null
}

const hardDeny = (action: ToolAction): PermissionDecision | null => {
  const reason = hardDenyReason(action)
  return reason ? { kind: "deny", reason } : null
}

/* ------------------------------------------------------------------------- *
 * Codex HITL 4-tier (hitl-audit.md) — tier inference.
 *
 * Precedence: `tool.hitlTier(input)` explicit value wins (e.g. `bash`'s
 * network-egress + mutating-git classifier returning `always-confirm`).
 * Absent ⇒ FAIL-CLOSED fallback:
 *   - read-only tool                    ⇒ "none" (reversible, harmless)
 *   - mutating tool with NO hitlTier()  ⇒ "always-confirm" (NOT
 *     "pre-approval-ok")
 *
 * Rationale (security audit Round 3): a future high-blast-radius tool —
 * `email_send`, `payment_authorize`, `slack_dm` — that forgets to implement
 * `hitlTier()` would silently drop into a tier batch-approved by
 * `acceptEdits`/`bypass` mode. Secure-by-default reverses the burden: the
 * registry MUST explicitly opt a mutating tool into `pre-approval-ok`
 * before it can ride loose. Existing default tools (`write`/`edit`/
 * `test_runner`/`scripted_replace`) declare `hitlTier(): "pre-approval-ok"`
 * explicitly to preserve their current behavior; an audit catches a missing
 * declaration on a new tool as soon as a user invokes it under `bypass`.
 *
 * `@/permission` stays leaf: the helper duck-reads the `hitlTier` method off
 * a thin interface (no `@/tool` import).
 * ------------------------------------------------------------------------- */

interface HITLToolDuck {
  isReadOnly(): boolean
  hitlTier?(input: unknown): HITLTier
}

/** Infer the effective HITL tier for a call. The tool's own `hitlTier(input)`
 *  wins; otherwise read-only ⇒ "none", mutating ⇒ "always-confirm" (FAIL-
 *  CLOSED — see module comment). The dispatch seam composes this with the
 *  HARD_DENY check (which overrides to "hand-off-required") to obtain the
 *  final routing tier. */
export const inferToolTier = (tool: HITLToolDuck, input: unknown): HITLTier => {
  const explicit = tool.hitlTier?.(input)
  if (explicit) return explicit
  return tool.isReadOnly() ? "none" : "always-confirm"
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
